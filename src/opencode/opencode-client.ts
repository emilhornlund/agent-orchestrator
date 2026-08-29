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
  environment?: Record<string, string>;
  sessionLogPath?: string;
  sessionLabel?: string;
}

export interface OpenCodeRunResult {
  exitCode: number;
  output: string;
  errorOutput: string;
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
      [
        "run",
        "--auto",
        "--model",
        model,
        "--variant",
        variant,
        "--dir",
        cwd,
        prompt,
      ],
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

  run(options: OpenCodeRunOptions): Promise<OpenCodeRunResult> {
    return this.runOpenCode(options);
  }
}
