import { spawn } from "node:child_process";
import {
  buildChildEnvironment,
  providerFromModel,
} from "../process/child-environment.js";

import { logger } from "../logging/logger.js";
import {
  createSecretRedactor,
  redactSecrets,
} from "../security/redact-secrets.js";
import {
  appendSessionLog,
  appendSessionSection,
} from "../logging/session-log.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import {
  beginProcessEvidence,
  drainProcessGroup,
  getProcessRuntime,
  signalProcessGroup,
  ProcessEvidenceError,
  appendBoundedOutput,
  ProcessOutputLimitError,
  ProcessExecutionError,
} from "../process/process-runtime.js";

const shutdownGraceMilliseconds = 5_000;

export interface OpenCodeRunOptions {
  cwd: string;
  model: string;
  variant: string;
  timeoutMilliseconds: number;
  prompt: string;
  signal: AbortSignal;
  sessionId?: string;
  captureSessionId?: boolean;
  readOnly?: boolean;
  environment?: Record<string, string>;
  sessionLogPath?: string;
  sessionLabel?: string;
  secretValues?: readonly string[];
}

export interface OpenCodeRunResult {
  exitCode: number;
  output: string;
  errorOutput: string;
  processExecutionId?: string;
  sessionId?: string;
}

export class OpenCodeRunAbortedError extends Error {
  constructor() {
    super("OpenCode run aborted");
    this.name = "OpenCodeRunAbortedError";
  }
}

export class OpenCodeTimeoutError extends Error {
  constructor(timeoutMilliseconds: number, executionId?: string) {
    super(
      `OpenCode exceeded safety timeout of ${timeoutMilliseconds}ms${executionId === undefined ? "" : `; diagnostics: process-executions/${executionId}/stderr.txt`}`,
    );
    this.name = "OpenCodeTimeoutError";
  }
}

export type RunOpenCode = (
  options: OpenCodeRunOptions,
) => Promise<OpenCodeRunResult>;

type OpenCodeArgumentOptions = Pick<
  OpenCodeRunOptions,
  "cwd" | "model" | "variant" | "prompt" | "sessionId" | "captureSessionId"
>;

export function buildOpenCodeConfigContent(readOnly = false): string {
  return JSON.stringify({
    permission: {
      question: "deny",
      ...(readOnly
        ? {
            edit: "deny",
            bash: "deny",
            external_directory: "deny",
          }
        : {}),
    },
  });
}

function assertValidSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(sessionId)) {
    throw new Error(
      "Invalid OpenCode session ID: expected letters, numbers, underscores, or hyphens",
    );
  }
}

export function buildOpenCodeArguments(
  options: OpenCodeArgumentOptions,
): string[] {
  const { cwd, model, variant, prompt, sessionId, captureSessionId } = options;

  if (sessionId !== undefined) {
    assertValidSessionId(sessionId);
  }

  if (captureSessionId === true && sessionId !== undefined) {
    throw new Error(
      "Cannot capture a newly created OpenCode session while resuming an existing session",
    );
  }

  return [
    "run",
    "--auto",
    "--model",
    model,
    "--variant",
    variant,
    "--dir",
    cwd,
    ...(sessionId === undefined ? [] : ["--session", sessionId]),
    ...(captureSessionId === true ? ["--format", "json"] : []),
    prompt,
  ];
}

export class OpenCodeSessionIdParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpenCodeSessionIdParseError";
  }
}

export class OpenCodeSessionIdCaptureError extends Error {
  constructor(
    message: string,
    public readonly runResult: OpenCodeRunResult,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OpenCodeSessionIdCaptureError";
  }
}

export class OpenCodeTextOutputParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpenCodeTextOutputParseError";
  }
}

function parseOpenCodeEventV1(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpenCodeSessionIdParseError(
      "Structured OpenCode output contains a non-object event",
    );
  }

  if (!("type" in value) || typeof value.type !== "string") {
    throw new OpenCodeSessionIdParseError(
      "Structured OpenCode event is missing its event type",
    );
  }

  if (
    "version" in value &&
    value.version !== undefined &&
    value.version !== 1
  ) {
    throw new OpenCodeSessionIdParseError(
      `Unsupported OpenCode JSON event version: ${String(value.version)}`,
    );
  }

  if (!("sessionID" in value)) {
    return undefined;
  }

  if (typeof value.sessionID !== "string") {
    throw new OpenCodeSessionIdParseError(
      "Structured OpenCode event has an invalid sessionID",
    );
  }

  try {
    assertValidSessionId(value.sessionID);
  } catch (error) {
    throw new OpenCodeSessionIdParseError(
      "Structured OpenCode event has an invalid sessionID",
      { cause: error },
    );
  }

  return value.sessionID;
}

export function parseOpenCodeSessionId(output: string): string {
  const lines = output.split(/\r?\n/u).filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    throw new OpenCodeSessionIdParseError(
      "Structured OpenCode output did not contain any events",
    );
  }

  const sessionIds = new Set<string>();

  for (const [index, line] of lines.entries()) {
    let value: unknown;

    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new OpenCodeSessionIdParseError(
        `Structured OpenCode output contains malformed JSON on line ${index + 1}`,
        { cause: error },
      );
    }

    const sessionId = parseOpenCodeEventV1(value);

    if (sessionId !== undefined) {
      sessionIds.add(sessionId);
    }
  }

  if (sessionIds.size === 0) {
    throw new OpenCodeSessionIdParseError(
      "Structured OpenCode output did not contain a session ID",
    );
  }

  if (sessionIds.size > 1) {
    throw new OpenCodeSessionIdParseError(
      "Structured OpenCode output contained ambiguous session IDs",
    );
  }

  const [sessionId] = sessionIds;

  if (sessionId === undefined) {
    throw new OpenCodeSessionIdParseError(
      "Structured OpenCode output did not contain a session ID",
    );
  }

  return sessionId;
}

export function extractOpenCodeTextOutput(output: string): string {
  const lines = output.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const textParts: string[] = [];

  for (const [index, line] of lines.entries()) {
    let value: unknown;

    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new OpenCodeTextOutputParseError(
        `Structured OpenCode output contains malformed JSON on line ${index + 1}`,
        { cause: error },
      );
    }

    parseOpenCodeEventV1(value);

    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      "type" in value &&
      value.type === "text"
    ) {
      if (
        !("part" in value) ||
        typeof value.part !== "object" ||
        value.part === null ||
        !("type" in value.part) ||
        value.part.type !== "text" ||
        !("text" in value.part) ||
        typeof value.part.text !== "string"
      ) {
        throw new OpenCodeTextOutputParseError(
          `Structured OpenCode text event is malformed on line ${index + 1}`,
        );
      }

      textParts.push(value.part.text);
    }
  }

  if (textParts.length === 0) {
    throw new OpenCodeTextOutputParseError(
      "Structured OpenCode output did not contain assistant text",
    );
  }

  return textParts.join("");
}

export function signalProcessTree(
  childPid: number | undefined,
  signal: NodeJS.Signals,
  killChild: (signal: NodeJS.Signals) => boolean,
): void {
  signalProcessGroup(childPid, signal, killChild);
}

const defaultRunOpenCode: RunOpenCode = async ({
  cwd,
  model,
  variant,
  timeoutMilliseconds,
  prompt,
  signal,
  sessionId,
  captureSessionId,
  readOnly,
  environment,
  sessionLogPath,
  sessionLabel,
  secretValues,
}) =>
  new Promise((resolve, reject) => {
    const lifecycleSignal = getProcessRuntime().signal;
    const effectiveSignal =
      lifecycleSignal === undefined || lifecycleSignal === signal
        ? signal
        : AbortSignal.any([signal, lifecycleSignal]);
    if (effectiveSignal.aborted) {
      reject(new OpenCodeRunAbortedError());
      return;
    }

    if (sessionLogPath) {
      appendSessionSection(sessionLogPath, sessionLabel ?? "OpenCode session");

      appendSessionLog(
        sessionLogPath,
        [
          `Working directory: ${cwd}`,
          `Model: ${model}`,
          `Variant: ${variant}`,
          "",
        ].join("\n"),
      );
    }

    const execution = beginProcessEvidence(
      `opencode run --model ${model} --variant ${variant}`,
      cwd,
      secretValues,
    );

    const child = spawn(
      "opencode",
      buildOpenCodeArguments({
        cwd,
        model,
        variant,
        prompt: redactSecrets(prompt, secretValues),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(captureSessionId === undefined ? {} : { captureSessionId }),
      }),
      {
        cwd,
        stdio: ["inherit", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: {
          ...buildChildEnvironment(
            "opencode",
            environment,
            process.env,
            providerFromModel(model),
          ),
          OPENCODE_CONFIG_CONTENT: buildOpenCodeConfigContent(readOnly),
        },
      },
    );

    let output = "";
    let errorOutput = "";
    const stdoutRedactor = createSecretRedactor(secretValues);
    const stderrRedactor = createSecretRedactor(secretValues);
    let settled = false;
    let timedOut = false;
    let recorderFailure: Error | undefined;
    let captureFailure: Error | undefined;
    let redactorsFlushed = false;

    let forceKillTimeout: NodeJS.Timeout | undefined;

    function recordSession(text: string): void {
      if (!sessionLogPath || text.length === 0) return;
      try {
        appendSessionLog(sessionLogPath, text);
      } catch (error) {
        recorderFailure ??=
          error instanceof Error ? error : new Error(String(error));
      }
    }

    const safetyTimeout = setTimeout(() => {
      if (settled) {
        return;
      }

      timedOut = true;

      if (sessionLogPath) {
        recordSession(
          `\nOpenCode exceeded safety timeout of ${timeoutMilliseconds}ms; terminating\n`,
        );
      }

      terminate();
    }, timeoutMilliseconds);

    safetyTimeout.unref();

    function terminate(): void {
      signalProcessTree(child.pid, "SIGTERM", (signal) => child.kill(signal));

      forceKillTimeout = setTimeout(() => {
        if (settled) {
          return;
        }

        if (sessionLogPath)
          recordSession(
            "\nOpenCode did not exit after SIGTERM; sending SIGKILL\n",
          );
        signalProcessTree(child.pid, "SIGKILL", (signal) => child.kill(signal));
      }, shutdownGraceMilliseconds);

      forceKillTimeout.unref();
    }

    function handleAbort(): void {
      terminate();
    }

    function flushOutput(): void {
      if (redactorsFlushed) return;
      redactorsFlushed = true;
      const stdout = stdoutRedactor.flush();
      const stderr = stderrRedactor.flush();
      if (captureFailure === undefined) {
        try {
          output = appendBoundedOutput(output, stdout, "stdout");
          errorOutput = appendBoundedOutput(errorOutput, stderr, "stderr");
        } catch {
          captureFailure = new ProcessOutputLimitError(
            "stdout",
            undefined,
            execution.executionId,
          );
          terminate();
        }
      }
      execution.append("stdout", stdout);
      execution.append("stderr", stderr);
      recorderFailure ??= execution.failure;
      recordSession(stdout);
      recordSession(stderr);
      if (recorderFailure !== undefined) terminate();
    }

    effectiveSignal.addEventListener("abort", handleAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      const text = stdoutRedactor.push(chunk.toString());

      if (captureFailure === undefined) {
        try {
          output = appendBoundedOutput(output, text, "stdout");
        } catch {
          captureFailure = new ProcessOutputLimitError(
            "stdout",
            undefined,
            execution.executionId,
          );
          terminate();
        }
      }
      execution.append("stdout", text);
      if (execution.failure !== undefined) {
        recorderFailure ??= execution.failure;
        terminate();
        return;
      }

      recordSession(text);
      if (recorderFailure !== undefined) terminate();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = stderrRedactor.push(chunk.toString());

      if (captureFailure === undefined) {
        try {
          errorOutput = appendBoundedOutput(errorOutput, text, "stderr");
        } catch {
          captureFailure = new ProcessOutputLimitError(
            "stderr",
            undefined,
            execution.executionId,
          );
          terminate();
        }
      }
      execution.append("stderr", text);
      if (execution.failure !== undefined) {
        recorderFailure ??= execution.failure;
        terminate();
        return;
      }

      recordSession(text);
      if (recorderFailure !== undefined) terminate();
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }

      flushOutput();

      logger.error(
        `Failed to start OpenCode; diagnostics: process-executions/${execution.executionId}/stderr.txt`,
      );

      settled = true;
      try {
        execution.finish("spawn-failure", {
          pid: child.pid,
          error: redactSecrets(error.message, secretValues),
        });
      } catch (finishError) {
        clearTimeout(safetyTimeout);
        if (forceKillTimeout !== undefined) clearTimeout(forceKillTimeout);
        effectiveSignal.removeEventListener("abort", handleAbort);
        reject(finishError);
        return;
      }
      clearTimeout(safetyTimeout);
      if (forceKillTimeout !== undefined) {
        clearTimeout(forceKillTimeout);
      }
      effectiveSignal.removeEventListener("abort", handleAbort);

      reject(
        new ProcessExecutionError(
          "OpenCode",
          execution.executionId,
          "spawn-failure",
        ),
      );
    });

    child.once("close", async (code, signalName) => {
      if (settled) {
        return;
      }

      try {
        await drainProcessGroup(child.pid, (signal) => child.kill(signal));
      } catch (error) {
        if (settled) return;
        flushOutput();
        settled = true;
        clearTimeout(safetyTimeout);
        if (forceKillTimeout !== undefined) clearTimeout(forceKillTimeout);
        effectiveSignal.removeEventListener("abort", handleAbort);
        try {
          execution.finish("process-group-ambiguous", { pid: child.pid });
        } catch (finishError) {
          recorderFailure ??=
            finishError instanceof Error
              ? finishError
              : new ProcessEvidenceError(
                  "OpenCode evidence finalization failed",
                );
        }
        reject(error);
        return;
      }
      if (settled) return;

      flushOutput();

      settled = true;
      clearTimeout(safetyTimeout);
      if (forceKillTimeout !== undefined) {
        clearTimeout(forceKillTimeout);
      }
      effectiveSignal.removeEventListener("abort", handleAbort);
      try {
        execution.finish(
          recorderFailure !== undefined ||
            captureFailure !== undefined ||
            execution.failure !== undefined
            ? "evidence-failure"
            : timedOut
              ? "timeout"
              : effectiveSignal.aborted
                ? "interrupted"
                : code === 0
                  ? "success"
                  : "nonzero",
          {
            pid: child.pid,
            exitCode: code ?? 1,
            ...(signalName === null ? {} : { signal: signalName }),
          },
        );
      } catch (error) {
        recorderFailure ??=
          error instanceof Error
            ? error
            : new ProcessEvidenceError("OpenCode evidence finalization failed");
      }
      recorderFailure ??= execution.failure;
      if (recorderFailure !== undefined) {
        reject(recorderFailure);
        return;
      }
      if (captureFailure !== undefined) {
        reject(captureFailure);
        return;
      }

      if (timedOut) {
        reject(
          new OpenCodeTimeoutError(timeoutMilliseconds, execution.executionId),
        );
        return;
      }

      if (effectiveSignal.aborted) {
        reject(new OpenCodeRunAbortedError());
        return;
      }

      resolve({
        exitCode: code ?? 1,
        output,
        errorOutput,
        processExecutionId: execution.executionId,
      });
    });
  });

export class OpenCodeClient {
  constructor(
    private readonly runOpenCode: RunOpenCode = defaultRunOpenCode,
    private readonly configuredSecretValues: readonly string[] = [],
  ) {}

  async run(options: OpenCodeRunOptions): Promise<OpenCodeRunResult> {
    const projectId = ProjectRunAuthority.currentProjectId();
    return projectId === undefined
      ? this.runOwned(options)
      : ProjectRunAuthority.dispatch(projectId, () => this.runOwned(options));
  }

  private async runOwned(
    options: OpenCodeRunOptions,
  ): Promise<OpenCodeRunResult> {
    if (options.sessionId !== undefined) {
      assertValidSessionId(options.sessionId);
    }

    if (options.captureSessionId === true && options.sessionId !== undefined) {
      throw new Error(
        "Cannot capture a newly created OpenCode session while resuming an existing session",
      );
    }

    const secretValues = [
      ...this.configuredSecretValues,
      ...getProcessRuntime().secretValues,
      ...(options.secretValues ?? []),
    ];
    const result = await this.runOpenCode({
      ...options,
      ...(secretValues.length === 0 ? {} : { secretValues }),
    });

    if (options.captureSessionId !== true) {
      return result;
    }

    try {
      return { ...result, sessionId: parseOpenCodeSessionId(result.output) };
    } catch (error) {
      throw new OpenCodeSessionIdCaptureError(
        "Could not capture the created OpenCode session ID",
        result,
        { cause: error },
      );
    }
  }
}
