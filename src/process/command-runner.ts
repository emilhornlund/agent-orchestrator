import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { buildChildEnvironment, type ChildProcessFamily } from "./child-environment.js";

import { appendSessionLog, appendSessionSection } from "../logging/session-log.js";
import { createSecretRedactor, redactSecrets } from "../security/redact-secrets.js";
import {
  MAX_EXTERNAL_DIAGNOSTIC_LENGTH,
  presentExternalDiagnostic,
} from "../security/bounded-diagnostic.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import {
  withTaskExecutionActivity,
  assertNoTerminalPr,
} from "../task-session/terminal-pr-fence.js";
import { getGitHubOperationProject } from "../github/github-operation-context.js";
import { containedProcess, observeContainedProcess } from "./contained-process.js";
import {
  PROCESS_CAPTURE_MAX_BYTES,
  appendBoundedOutput,
  beginProcessEvidence,
  signalProcessGroup,
  getProcessRuntime,
  guardProcessClose,
  ProcessEvidenceError,
  ProcessOutputLimitError,
  ProcessExecutionError,
} from "./process-runtime.js";

const commandTerminationGraceMilliseconds = 5_000;

function signalProcessTree(
  childPid: number | undefined,
  signal: NodeJS.Signals,
  killChild: (signal: NodeJS.Signals) => boolean,
): void {
  signalProcessGroup(childPid, signal, killChild);
}

export interface CommandRunOptions {
  cwd: string;
  command: string;
  signal?: AbortSignal;
  timeoutMilliseconds?: number;
  captureOutput?: boolean;
  /** Summarize captured output for diagnostics, or return complete bounded output for parsing. */
  capturePolicy?: "diagnostic-summary" | "complete";
  maxCaptureOutputLength?: number;
  suppressOutput?: boolean;
  environment?: Record<string, string>;
  processFamily?: ChildProcessFamily;
  secretValues?: readonly string[];
  sessionLogPath?: string;
  sessionLabel?: string;
  /** External runtime location; defaults outside the source checkout. */
  artifactDirectory?: string;
  /** Called after durable execution evidence is created and before spawn. */
  onExecutionStarted?: (executionId: string) => void;
}

export interface CommandRunResult {
  exitCode: number;
  output?: string;
  errorOutput?: string;
  /** Stable identifier for the persisted process evidence, when available. */
  executionId?: string;
  /** Artifact-relative reference to the captured stdout. */
  stdoutArtifactReference?: string;
}

export type RunCommand = (options: CommandRunOptions) => Promise<CommandRunResult>;

export class CommandRunAbortedError extends Error {
  constructor() {
    super("Command run aborted");
    this.name = "CommandRunAbortedError";
  }
}

export class CommandRunInterruptedError extends Error {
  constructor(public readonly signalName: NodeJS.Signals) {
    super(`Command process was interrupted by ${signalName}`);
    this.name = "CommandRunInterruptedError";
  }
}

export class CommandTimeoutError extends Error {
  constructor(timeoutMilliseconds: number) {
    super(`Command exceeded safety timeout of ${timeoutMilliseconds}ms`);
    this.name = "CommandTimeoutError";
  }
}

const defaultRunCommand: RunCommand = async ({
  cwd,
  command,
  signal,
  timeoutMilliseconds,
  captureOutput,
  capturePolicy,
  maxCaptureOutputLength,
  suppressOutput,
  environment,
  processFamily,
  secretValues,
  sessionLogPath,
  sessionLabel,
  artifactDirectory,
  onExecutionStarted,
}) =>
  new Promise((resolve, reject) => {
    const runtime = getProcessRuntime();
    const effectiveSignal =
      signal === undefined || runtime.signal === undefined || signal === runtime.signal
        ? (signal ?? runtime.signal)
        : AbortSignal.any([signal, runtime.signal]);
    const effectiveTimeout =
      timeoutMilliseconds ??
      (getGitHubOperationProject()?.opencode.timeoutMinutes ??
        runtime.operationTimeoutMilliseconds / 60_000) * 60_000;
    const effectiveSecretValues = [...(secretValues ?? []), ...runtime.secretValues];
    if (effectiveSignal?.aborted) {
      reject(new CommandRunAbortedError());
      return;
    }

    if (sessionLogPath) {
      appendSessionSection(sessionLogPath, sessionLabel ?? "Command");

      appendSessionLog(
        sessionLogPath,
        redactSecrets(
          [`Working directory: ${cwd}`, `Command: ${command}`, ""].join("\n"),
          effectiveSecretValues,
        ),
      );
    }

    const projectId = ProjectRunAuthority.currentProjectId();
    const authority = projectId ? ProjectRunAuthority.current(projectId) : undefined;
    const record = authority?.store.read();
    const taskArtifactDirectory =
      record && projectId
        ? `${record.pinned.storageRoot}/artifacts/${encodeURIComponent(projectId)}/${encodeURIComponent(record.cardId)}/${encodeURIComponent(record.attemptId)}`
        : undefined;
    const artifactDirectoryOverride = artifactDirectory ?? taskArtifactDirectory;
    const execution = beginProcessEvidence(
      command,
      cwd,
      effectiveSecretValues,
      artifactDirectoryOverride,
    );
    try {
      onExecutionStarted?.(execution.executionId);
    } catch (error) {
      try {
        execution.finish("spawn-failure", {
          error: "execution binding failed",
        });
      } catch {
        // Preserve the binding failure and do not dispatch the command.
      }
      reject(error);
      return;
    }
    if (effectiveSignal?.aborted) {
      execution.finish("not-dispatched", { cancellationRequested: true });
      reject(new CommandRunAbortedError());
      return;
    }
    let dispatch: ReturnType<typeof containedProcess>;
    try {
      dispatch = containedProcess("/bin/sh", ["-c", command]);
    } catch (error) {
      execution.finish("not-dispatched");
      reject(error);
      return;
    }
    const child = spawn(dispatch.command, dispatch.args, {
      cwd,
      stdio: ["inherit", "pipe", "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: buildChildEnvironment(processFamily ?? "command", environment),
    });
    let settled = false;
    let timedOut = false;
    let terminationRequested = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    const stdoutRedactor = createSecretRedactor(effectiveSecretValues);
    const stderrRedactor = createSecretRedactor(effectiveSecretValues);
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let outputFlushed = false;
    let capturedOutput: string | undefined;
    let capturedErrorOutput: string | undefined;
    let captureFailure: Error | undefined;
    let supervisorExitCode: number | null | undefined;
    let payloadSpawned: boolean | undefined;
    const closeGuard = guardProcessClose(child, (error) => {
      if (settled) return;
      flushOutput();
      settle("process-group-ambiguous");
      reject(error);
    });
    const supervision = observeContainedProcess(child, (error) => {
      captureFailure = error;
      terminate();
    });

    function capture(
      text: string,
      current: string | undefined,
      stream: "stdout" | "stderr",
    ): string | undefined {
      if (captureOutput !== true || text.length === 0) return current;
      const limit = PROCESS_CAPTURE_MAX_BYTES;
      try {
        return appendBoundedOutput(current ?? "", text, stream, limit);
      } catch (error) {
        captureFailure =
          error instanceof Error ? error : new ProcessOutputLimitError(stream, limit);
        terminate();
        return current;
      }
    }

    function writeOutput(text: string, stream: NodeJS.WriteStream): void {
      if (text.length === 0) {
        return;
      }

      execution.append(stream === process.stdout ? "stdout" : "stderr", text);
      if (execution.failure !== undefined) {
        captureFailure = execution.failure;
        terminate();
        return;
      }

      if (sessionLogPath) {
        try {
          appendSessionLog(sessionLogPath, text);
        } catch (error) {
          captureFailure = error instanceof Error ? error : new Error(String(error));
          terminate();
        }
      } else if (suppressOutput === true) {
        return;
      } else {
        // Child output is retained in redacted artifacts, never emitted raw to the orchestrator console.
      }
    }

    function flushOutput(): void {
      if (outputFlushed) {
        return;
      }

      outputFlushed = true;
      const stdout = stdoutRedactor.push(stdoutDecoder.end()) + stdoutRedactor.flush();
      const stderr = stderrRedactor.push(stderrDecoder.end()) + stderrRedactor.flush();
      writeOutput(stdout, process.stdout);
      writeOutput(stderr, process.stderr);
      capturedOutput = capture(stdout, capturedOutput, "stdout");
      capturedErrorOutput = capture(stderr, capturedErrorOutput, "stderr");
    }

    function settle(status: string, exitCode?: number, signalName?: NodeJS.Signals): void {
      settled = true;

      if (timeout !== undefined) {
        clearTimeout(timeout);
      }

      if (forceKillTimeout !== undefined) {
        clearTimeout(forceKillTimeout);
      }

      effectiveSignal?.removeEventListener("abort", handleAbort);
      closeGuard.dispose();
      try {
        execution.finish(
          (captureFailure ?? execution.failure) !== undefined ? "evidence-failure" : status,
          {
            pid: child.pid,
            containment: "linux-pid-namespace",
            treeStopped:
              supervisorExitCode !== undefined &&
              ["success", "nonzero", "interrupted", "timeout", "spawn-failure"].includes(status),
            ...(supervisorExitCode === undefined ? {} : { supervisorExitCode }),
            ...(payloadSpawned === undefined ? {} : { payloadSpawned }),
            ...(exitCode === undefined ? {} : { exitCode }),
            ...(signalName === undefined ? {} : { signal: signalName }),
          },
        );
      } catch (error) {
        reject(
          new ProcessEvidenceError("Could not finalize process evidence", {
            cause: error,
          }),
        );
      }
    }

    function terminate(): void {
      if (settled || terminationRequested) {
        return;
      }
      terminationRequested = true;

      signalProcessTree(child.pid, "SIGTERM", (signal) => child.kill(signal));

      forceKillTimeout = setTimeout(() => {
        if (settled) {
          return;
        }

        signalProcessTree(child.pid, "SIGKILL", (signal) => child.kill(signal));
        closeGuard.afterHardKill();
      }, commandTerminationGraceMilliseconds);
    }

    function handleAbort(): void {
      terminate();
    }

    if (effectiveSignal) {
      effectiveSignal.addEventListener("abort", handleAbort, { once: true });
    }

    if (effectiveTimeout > 0) {
      timeout = setTimeout(() => {
        if (settled || terminationRequested) {
          return;
        }

        timedOut = true;
        terminate();
      }, effectiveTimeout);
    }

    child.stdout!.on("data", (chunk: Buffer) => {
      const text = stdoutDecoder.write(chunk);
      const redacted = stdoutRedactor.push(text);
      writeOutput(redacted, process.stdout);
      capturedOutput = capture(redacted, capturedOutput, "stdout");
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      const text = stderrDecoder.write(chunk);
      const redacted = stderrRedactor.push(text);
      writeOutput(redacted, process.stderr);
      capturedErrorOutput = capture(redacted, capturedErrorOutput, "stderr");
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }

      flushOutput();
      settle("spawn-failure");

      reject(
        new Error(
          `Failed to start command: ${redactSecrets(error.message, effectiveSecretValues)}`,
          {
            cause: error,
          },
        ),
      );
    });

    child.once("close", (code, signalName) => {
      if (settled) {
        return;
      }

      supervisorExitCode = code;
      try {
        const payload = supervision.result(code, signalName);
        code = payload.spawned === false ? 1 : payload.code;
        signalName = payload.signal;
        payloadSpawned = payload.spawned;
      } catch (error) {
        captureFailure =
          error instanceof Error
            ? error
            : new ProcessEvidenceError("Invalid contained command result");
      }

      flushOutput();
      const interruptedBySignal =
        signalName !== null &&
        signalName !== undefined &&
        !timedOut &&
        effectiveSignal?.aborted !== true;
      const cancelled =
        effectiveSignal?.aborted === true &&
        (code === 0 || ["SIGINT", "SIGTERM", "SIGKILL"].includes(signalName ?? ""));
      settle(
        payloadSpawned === false
          ? "spawn-failure"
          : timedOut
            ? "timeout"
            : cancelled
              ? "interrupted"
              : interruptedBySignal
                ? "interrupted"
                : code === 0
                  ? "success"
                  : "nonzero",
        code ?? undefined,
        signalName ?? undefined,
      );

      if (payloadSpawned === false) {
        reject(new ProcessExecutionError("Command", execution.executionId, "spawn-failure"));
        return;
      }

      if (timedOut) {
        reject(new CommandTimeoutError(effectiveTimeout));
        return;
      }

      captureFailure ??= execution.failure;
      if (captureFailure !== undefined) {
        reject(captureFailure);
        return;
      }

      if (cancelled) {
        reject(new CommandRunAbortedError());
        return;
      }

      if (interruptedBySignal) {
        reject(new CommandRunInterruptedError(signalName!));
        return;
      }

      resolve({
        exitCode: code ?? 1,
        executionId: execution.executionId,
        stdoutArtifactReference:
          artifactDirectoryOverride === undefined
            ? `process-executions/${execution.executionId}/stdout.txt`
            : `${execution.executionId}/stdout.txt`,
        ...(captureOutput === true
          ? {
              output:
                capturePolicy === "complete"
                  ? (capturedOutput ?? "")
                  : presentExternalDiagnostic(
                      capturedOutput ?? "",
                      effectiveSecretValues,
                      maxCaptureOutputLength ?? MAX_EXTERNAL_DIAGNOSTIC_LENGTH,
                    ),
              errorOutput:
                capturePolicy === "complete"
                  ? (capturedErrorOutput ?? "")
                  : presentExternalDiagnostic(
                      capturedErrorOutput ?? "",
                      effectiveSecretValues,
                      maxCaptureOutputLength ?? MAX_EXTERNAL_DIAGNOSTIC_LENGTH,
                    ),
            }
          : {}),
      });
    });

    try {
      execution.dispatched(child.pid, "linux-pid-namespace");
    } catch (error) {
      // All listeners and tree supervision are installed before the metadata
      // update. A failed PID binding is not permission to leave the child
      // running unobserved.
      captureFailure =
        error instanceof Error
          ? error
          : new ProcessEvidenceError("Could not persist child process identity");
      terminate();
    }
  });

export class CommandRunner {
  constructor(
    private readonly runCommand: RunCommand = defaultRunCommand,
    private readonly lifecycleSignal?: AbortSignal,
  ) {}

  run(options: CommandRunOptions): Promise<CommandRunResult> {
    const lifecycleSignal = this.lifecycleSignal ?? getProcessRuntime().signal;
    const effectiveOptions =
      options.signal !== undefined || lifecycleSignal === undefined
        ? options
        : { ...options, signal: lifecycleSignal };
    const projectId = ProjectRunAuthority.currentProjectId();
    const authority = projectId === undefined ? undefined : ProjectRunAuthority.current(projectId);
    return withTaskExecutionActivity(authority, async () => {
      assertNoTerminalPr(authority, true);
      const result =
        projectId === undefined
          ? await this.runCommand(effectiveOptions)
          : await ProjectRunAuthority.dispatch(projectId, () => this.runCommand(effectiveOptions));
      assertNoTerminalPr(authority);
      return result;
    });
  }
}
