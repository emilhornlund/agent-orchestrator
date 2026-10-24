import { spawn } from "node:child_process";

import { logger } from "../logging/logger.js";
import {
  appendSessionLog,
  appendSessionSection,
} from "../logging/session-log.js";

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
  environment?: Record<string, string>;
  sessionLogPath?: string;
  sessionLabel?: string;
}

export interface OpenCodeRunResult {
  exitCode: number;
  output: string;
  errorOutput: string;
  sessionId?: string;
}

export class OpenCodeRunAbortedError extends Error {
  constructor() {
    super("OpenCode run aborted");
    this.name = "OpenCodeRunAbortedError";
  }
}

export class OpenCodeTimeoutError extends Error {
  constructor(timeoutMilliseconds: number) {
    super(`OpenCode exceeded safety timeout of ${timeoutMilliseconds}ms`);
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

export function signalProcessTree(
  childPid: number | undefined,
  signal: NodeJS.Signals,
  killChild: (signal: NodeJS.Signals) => boolean,
): void {
  if (childPid === undefined || process.platform === "win32") {
    killChild(signal);
    return;
  }

  try {
    process.kill(-childPid, signal);
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? error.code : undefined;

    if (code !== "ESRCH") {
      logger.error(
        `Failed to signal OpenCode process group with ${signal}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      killChild(signal);
    }
  }
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
  environment,
  sessionLogPath,
  sessionLabel,
}) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
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

    const child = spawn(
      "opencode",
      buildOpenCodeArguments({
        cwd,
        model,
        variant,
        prompt,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(captureSessionId === undefined ? {} : { captureSessionId }),
      }),
      {
        cwd,
        stdio: ["inherit", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          ...environment,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            permission: {
              question: "deny",
            },
          }),
        },
      },
    );

    let output = "";
    let errorOutput = "";
    let settled = false;
    let timedOut = false;

    let forceKillTimeout: NodeJS.Timeout | undefined;

    const safetyTimeout = setTimeout(() => {
      if (settled) {
        return;
      }

      timedOut = true;

      if (sessionLogPath) {
        appendSessionLog(
          sessionLogPath,
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

        if (sessionLogPath) {
          appendSessionLog(
            sessionLogPath,
            "\nOpenCode did not exit after SIGTERM; sending SIGKILL\n",
          );
        }

        signalProcessTree(child.pid, "SIGKILL", (signal) => child.kill(signal));
      }, shutdownGraceMilliseconds);

      forceKillTimeout.unref();
    }

    function handleAbort(): void {
      terminate();
    }

    signal.addEventListener("abort", handleAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();

      output += text;

      if (sessionLogPath) {
        appendSessionLog(sessionLogPath, text);
      } else {
        process.stdout.write(text);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();

      errorOutput += text;

      if (sessionLogPath) {
        appendSessionLog(sessionLogPath, text);
      } else {
        process.stderr.write(text);
      }
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(safetyTimeout);
      if (forceKillTimeout !== undefined) {
        clearTimeout(forceKillTimeout);
      }
      signal.removeEventListener("abort", handleAbort);

      reject(
        new Error(`Failed to start OpenCode: ${error.message}`, {
          cause: error,
        }),
      );
    });

    child.once("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(safetyTimeout);
      if (forceKillTimeout !== undefined) {
        clearTimeout(forceKillTimeout);
      }
      signal.removeEventListener("abort", handleAbort);

      if (timedOut) {
        reject(new OpenCodeTimeoutError(timeoutMilliseconds));
        return;
      }

      if (signal.aborted) {
        reject(new OpenCodeRunAbortedError());
        return;
      }

      resolve({
        exitCode: code ?? 1,
        output,
        errorOutput,
      });
    });
  });

export class OpenCodeClient {
  constructor(private readonly runOpenCode: RunOpenCode = defaultRunOpenCode) {}

  async run(options: OpenCodeRunOptions): Promise<OpenCodeRunResult> {
    if (options.sessionId !== undefined) {
      assertValidSessionId(options.sessionId);
    }

    if (options.captureSessionId === true && options.sessionId !== undefined) {
      throw new Error(
        "Cannot capture a newly created OpenCode session while resuming an existing session",
      );
    }

    const result = await this.runOpenCode(options);

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
