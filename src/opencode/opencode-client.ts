import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  buildChildEnvironment,
  hasOpenCodeProviderCredentials,
  openCodeDefaultConfigPathIssue,
  providerFromModel,
  providerForOpenCodeDefault,
} from "../process/child-environment.js";

import { logger } from "../logging/logger.js";
import { createSecretRedactor, redactSecrets } from "../security/redact-secrets.js";
import { appendSessionLog, appendSessionSection } from "../logging/session-log.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { isolatedOpenCodeDispatch } from "./isolated-dispatch.js";
import {
  assertNoTerminalPr,
  withTaskExecutionActivity,
} from "../task-session/terminal-pr-fence.js";
import {
  withAiExecutionCapacity,
  hasAiExecutionCapacity,
  bindAiCapacityExecution,
} from "../orchestrator/ai-execution-capacity.js";
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
  onExecutionPrepared?: (evidence: {
    executionId: string;
    metadataPath: string;
    artifactRoot: string;
  }) => void | Promise<void>;
  cwd: string;
  model?: string | undefined;
  variant?: string | undefined;
  timeoutMilliseconds: number;
  prompt: string;
  signal: AbortSignal;
  sessionId?: string;
  captureSessionId?: boolean;
  structuredOutput?: boolean;
  readOnly?: boolean;
  refinementResultDirectory?: string;
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
  failureClassification?: "dependency-outage";
}

export class OpenCodeRunAbortedError extends Error {
  constructor() {
    super("OpenCode run aborted");
    this.name = "OpenCodeRunAbortedError";
  }
}

export class OpenCodeDefaultProviderResolutionError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "OpenCode default model provider could not be resolved safely for environment credential scoping; configure the OpenCode default model in its supported config or authenticate that default provider through OpenCode's own auth store",
    );
    this.name = "OpenCodeDefaultProviderResolutionError";
  }
}

export class OpenCodeTimeoutError extends Error {
  public readonly treeStopped: boolean;
  public readonly executionId: string | undefined;
  constructor(timeoutMilliseconds: number, executionId?: string, treeStopped = false) {
    super(
      `OpenCode exceeded safety timeout of ${timeoutMilliseconds}ms${executionId === undefined ? "" : `; diagnostics: process-executions/${executionId}/stderr.txt`}`,
    );
    this.name = "OpenCodeTimeoutError";
    this.executionId = executionId;
    this.treeStopped = treeStopped;
  }
}

export type RunOpenCode = (options: OpenCodeRunOptions) => Promise<OpenCodeRunResult>;

/** Add an exact configured selection only when the CLI reports it as invalid. */
export function reportUnavailableOpenCodeSelection(
  result: OpenCodeRunResult,
  selection: Pick<OpenCodeRunOptions, "model" | "variant">,
): OpenCodeRunResult {
  if (result.exitCode === 0) return result;
  const diagnostic = `${result.output}\n${result.errorOutput}`;
  if (
    !/\b(?:unknown|unsupported|not found|does not exist)\b.{0,80}\b(?:model|variant)\b|\b(?:model|variant)\b.{0,80}\b(?:unknown|unsupported|not found|does not exist)\b/iu.test(
      diagnostic,
    ) ||
    (selection.model === undefined && selection.variant === undefined)
  ) {
    return result;
  }
  const selected = [
    selection.model === undefined ? undefined : `model=${JSON.stringify(selection.model)}`,
    selection.variant === undefined ? undefined : `variant=${JSON.stringify(selection.variant)}`,
  ].filter((value) => value !== undefined);
  return {
    ...result,
    errorOutput: `${result.errorOutput}${result.errorOutput.length === 0 ? "" : "\n"}Configured OpenCode selection unavailable: ${selected.join(", ")}`,
  };
}

type OpenCodeArgumentOptions = Pick<
  OpenCodeRunOptions,
  "cwd" | "model" | "variant" | "prompt" | "sessionId" | "captureSessionId" | "structuredOutput"
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

export function buildOpenCodeArguments(options: OpenCodeArgumentOptions): string[] {
  const { cwd, model, variant, prompt, sessionId, captureSessionId, structuredOutput } = options;

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
    "--pure",
    ...(model === undefined ? [] : ["--model", model]),
    ...(variant === undefined ? [] : ["--variant", variant]),
    "--dir",
    cwd,
    ...(sessionId === undefined ? [] : ["--session", sessionId]),
    ...(captureSessionId === true || structuredOutput === true ? ["--format", "json"] : []),
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
    throw new OpenCodeSessionIdParseError("Structured OpenCode output contains a non-object event");
  }

  if (!("type" in value) || typeof value.type !== "string") {
    throw new OpenCodeSessionIdParseError("Structured OpenCode event is missing its event type");
  }

  if ("version" in value && value.version !== undefined && value.version !== 1) {
    throw new OpenCodeSessionIdParseError(
      `Unsupported OpenCode JSON event version: ${String(value.version)}`,
    );
  }

  if (!("sessionID" in value)) {
    return undefined;
  }

  if (typeof value.sessionID !== "string") {
    throw new OpenCodeSessionIdParseError("Structured OpenCode event has an invalid sessionID");
  }

  try {
    assertValidSessionId(value.sessionID);
  } catch (error) {
    throw new OpenCodeSessionIdParseError("Structured OpenCode event has an invalid sessionID", {
      cause: error,
    });
  }

  return value.sessionID;
}

export function parseOpenCodeSessionId(output: string): string {
  const lines = output.split(/\r?\n/u).filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    throw new OpenCodeSessionIdParseError("Structured OpenCode output did not contain any events");
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

/** Some CLI plugins print import-time banners even under --pure. Allow only
 * bounded, tagged bootstrap diagnostics before the first event, never malformed
 * JSON events or interleaved output. Original bytes remain in stdout.txt. */
export function stripOpenCodePluginPreamble(output: string): string {
  const lines = output.split(/\r?\n/u);
  let start = 0;
  let bytes = 0;
  while (start < lines.length) {
    const line = lines[start]!;
    if (line.trim() === "") {
      start++;
      continue;
    }
    if (!/^\[[A-Za-z][A-Za-z0-9_.-]{0,63}\] [^\r\n]*$/u.test(line)) break;
    bytes += Buffer.byteLength(line);
    if (start >= 16 || bytes > 4096) return output;
    start++;
  }
  return lines.slice(start).join("\n");
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

function hasStructuredProviderOutage(output: string): boolean {
  for (const line of output.split(/\r?\n/u).slice(0, 128)) {
    if (line.length > 16_384) continue;
    try {
      const event: unknown = JSON.parse(line);
      if (
        typeof event !== "object" ||
        event === null ||
        Array.isArray(event) ||
        !("type" in event) ||
        event.type !== "error" ||
        ("version" in event && event.version !== undefined && event.version !== 1) ||
        !("error" in event) ||
        typeof event.error !== "object" ||
        event.error === null ||
        Array.isArray(event.error)
      )
        continue;
      const error = event.error as Record<string, unknown>;
      if (typeof error.data !== "object" || error.data === null) continue;
      const data = error.data as Record<string, unknown>;
      if (error.name === "APIError" && [429, 502, 503, 504].includes(data.statusCode as number))
        return true;
      const cause = data.cause;
      const causeCode =
        cause !== null && typeof cause === "object" && "code" in cause ? cause.code : undefined;
      if (
        error.name === "FetchError" &&
        [data.code, causeCode].some((code) =>
          [
            "ECONNREFUSED",
            "ECONNRESET",
            "EHOSTUNREACH",
            "ENETUNREACH",
            "EAI_AGAIN",
            "ENOTFOUND",
            "ETIMEDOUT",
          ].includes(code as string),
        )
      )
        return true;
    } catch {
      // Non-structured output is not sufficient evidence of provider availability.
    }
  }
  return false;
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
  structuredOutput,
  readOnly,
  refinementResultDirectory,
  environment,
  sessionLogPath,
  sessionLabel,
  secretValues,
  onExecutionPrepared,
}) =>
  new Promise((resolve, reject) => {
    void (async () => {
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
            `Model: ${model ?? "OpenCode default"}`,
            `Variant: ${variant ?? "OpenCode default"}`,
            "",
          ].join("\n"),
        );
      }

      const execution = beginProcessEvidence(
        `opencode run${model === undefined ? "" : ` --model ${model}`}${variant === undefined ? "" : ` --variant ${variant}`}`,
        cwd,
        secretValues,
      );

      const environmentSource = { ...process.env, ...environment };
      const configPathIssue = openCodeDefaultConfigPathIssue(environmentSource);
      if (model === undefined && configPathIssue !== undefined) {
        execution.finish("not-dispatched");
        reject(new OpenCodeDefaultProviderResolutionError(configPathIssue));
        return;
      }
      const effectiveProvider =
        providerFromModel(model) ?? providerForOpenCodeDefault(environmentSource);
      if (
        model === undefined &&
        effectiveProvider === undefined &&
        hasOpenCodeProviderCredentials(environment, process.env)
      ) {
        execution.finish("not-dispatched");
        reject(new OpenCodeDefaultProviderResolutionError());
        return;
      }

      try {
        if (onExecutionPrepared !== undefined)
          await onExecutionPrepared({
            executionId: execution.executionId,
            metadataPath: execution.metadataPath,
            artifactRoot: execution.artifactRoot,
          });
      } catch (error) {
        execution.finish("not-dispatched");
        throw error;
      }

      const childEnvironment = {
        ...buildChildEnvironment("opencode", environment, process.env, effectiveProvider),
        OPENCODE_CONFIG_CONTENT: buildOpenCodeConfigContent(readOnly),
      };
      const arguments_ = buildOpenCodeArguments({
        cwd,
        ...(model === undefined ? {} : { model }),
        ...(variant === undefined ? {} : { variant }),
        prompt: redactSecrets(prompt, secretValues),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(captureSessionId === undefined ? {} : { captureSessionId }),
        ...(structuredOutput === undefined ? {} : { structuredOutput }),
      });
      const authority = ProjectRunAuthority.currentProjectId();
      let dispatch = { command: "opencode", args: arguments_ };
      try {
        if (
          authority !== undefined &&
          (readOnly !== true || refinementResultDirectory !== undefined)
        )
          dispatch = isolatedOpenCodeDispatch(
            ProjectRunAuthority.current(authority)!,
            cwd,
            childEnvironment,
            arguments_,
            refinementResultDirectory,
          );
      } catch (error) {
        execution.finish("not-dispatched");
        throw error;
      }
      const child = spawn(dispatch.command, dispatch.args, {
        cwd,
        stdio: ["inherit", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: childEnvironment,
      });
      child.once("spawn", () => {
        try {
          execution.dispatched(child.pid);
        } catch (error) {
          recorderFailure ??=
            error instanceof Error
              ? error
              : new ProcessEvidenceError("Could not record OpenCode dispatch");
          terminate();
        }
      });

      let output = "";
      let errorOutput = "";
      const stdoutRedactor = createSecretRedactor(secretValues);
      const stderrRedactor = createSecretRedactor(secretValues);
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
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
          recorderFailure ??= error instanceof Error ? error : new Error(String(error));
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
            recordSession("\nOpenCode did not exit after SIGTERM; sending SIGKILL\n");
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
        const stdoutDecoded = stdoutRedactor.push(stdoutDecoder.end());
        const stderrDecoded = stderrRedactor.push(stderrDecoder.end());
        const stdout = stdoutDecoded + stdoutRedactor.flush();
        const stderr = stderrDecoded + stderrRedactor.flush();
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

      child.stdout.on("data", (chunk: Buffer | string) => {
        const text = stdoutRedactor.push(
          typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk),
        );

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

      child.stderr.on("data", (chunk: Buffer | string) => {
        const text = stderrRedactor.push(
          typeof chunk === "string" ? chunk : stderrDecoder.write(chunk),
        );

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

        reject(new ProcessExecutionError("OpenCode", execution.executionId, "spawn-failure"));
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
                : new ProcessEvidenceError("OpenCode evidence finalization failed");
          }
          reject(error);
          return;
        }
        if (settled) return;

        flushOutput();

        const failureClassification =
          code !== 0 && hasStructuredProviderOutage(output)
            ? ("dependency-outage" as const)
            : undefined;

        settled = true;
        clearTimeout(safetyTimeout);
        if (forceKillTimeout !== undefined) {
          clearTimeout(forceKillTimeout);
        }
        effectiveSignal.removeEventListener("abort", handleAbort);
        output = stripOpenCodePluginPreamble(output);
        let capturedSessionId: string | undefined;
        let sessionCaptureError: unknown;
        if (captureSessionId === true) {
          try {
            capturedSessionId = parseOpenCodeSessionId(output);
          } catch (error) {
            sessionCaptureError = error;
          }
        }
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
              result: {
                exitCode: code ?? 1,
                output,
                errorOutput,
                processExecutionId: execution.executionId,
                ...(failureClassification === undefined ? {} : { failureClassification }),
                ...((capturedSessionId ?? sessionId) === undefined
                  ? {}
                  : { sessionId: capturedSessionId ?? sessionId }),
              },
              ...((capturedSessionId ?? sessionId) === undefined
                ? {}
                : { sessionId: capturedSessionId ?? sessionId }),
              ...(failureClassification === undefined ? {} : { failureClassification }),
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
          reject(new OpenCodeTimeoutError(timeoutMilliseconds, execution.executionId, true));
          return;
        }

        if (effectiveSignal.aborted) {
          reject(new OpenCodeRunAbortedError());
          return;
        }

        if (sessionCaptureError !== undefined) {
          reject(
            new OpenCodeSessionIdCaptureError(
              `Could not capture the created OpenCode session ID; diagnostics: ${execution.metadataPath}`,
              {
                exitCode: code ?? 1,
                output,
                errorOutput,
                processExecutionId: execution.executionId,
                ...(failureClassification === undefined ? {} : { failureClassification }),
              },
              { cause: sessionCaptureError },
            ),
          );
          return;
        }

        resolve(
          reportUnavailableOpenCodeSelection(
            {
              exitCode: code ?? 1,
              output,
              errorOutput,
              processExecutionId: execution.executionId,
              ...(failureClassification !== undefined ? { failureClassification } : {}),
            },
            { model, variant },
          ),
        );
      });
    })().catch(reject);
  });

export class OpenCodeClient {
  constructor(
    private readonly runOpenCode: RunOpenCode = defaultRunOpenCode,
    private readonly configuredSecretValues: readonly string[] = [],
  ) {}

  async run(options: OpenCodeRunOptions): Promise<OpenCodeRunResult> {
    const projectId = ProjectRunAuthority.currentProjectId();
    const authority = projectId === undefined ? undefined : ProjectRunAuthority.current(projectId);
    assertNoTerminalPr(authority, true);
    return withTaskExecutionActivity(authority, () =>
      withAiExecutionCapacity(options.signal, async () => {
        assertNoTerminalPr(authority, true);
        const dispatchOptions =
          hasAiExecutionCapacity() || authority !== undefined
            ? {
                ...options,
                onExecutionPrepared: async (evidence: {
                  executionId: string;
                  metadataPath: string;
                  artifactRoot: string;
                }) => {
                  assertNoTerminalPr(authority, true);
                  bindAiCapacityExecution(
                    evidence,
                    options.cwd,
                    `opencode run${options.model === undefined ? "" : ` --model ${options.model}`}${options.variant === undefined ? "" : ` --variant ${options.variant}`}`,
                  );
                  await options.onExecutionPrepared?.(evidence);
                },
              }
            : options;
        const result =
          projectId === undefined
            ? await this.runOwned(dispatchOptions)
            : await ProjectRunAuthority.dispatch(projectId, () => this.runOwned(dispatchOptions));
        assertNoTerminalPr(authority);
        return result;
      }),
    );
  }

  private async runOwned(options: OpenCodeRunOptions): Promise<OpenCodeRunResult> {
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
      return options.sessionId === undefined ? result : { ...result, sessionId: options.sessionId };
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
