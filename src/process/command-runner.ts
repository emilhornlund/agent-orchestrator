import { spawn } from "node:child_process";

import {
  appendSessionLog,
  appendSessionSection,
} from "../logging/session-log.js";
import {
  createSecretRedactor,
  redactSecrets,
} from "../security/redact-secrets.js";
import {
  MAX_EXTERNAL_DIAGNOSTIC_LENGTH,
  presentExternalDiagnostic,
} from "../security/bounded-diagnostic.js";

const commandTerminationGraceMilliseconds = 5_000;

function signalProcessTree(
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
      killChild(signal);
    }
  }
}

export interface CommandRunOptions {
  cwd: string;
  command: string;
  signal?: AbortSignal;
  timeoutMilliseconds?: number;
  captureOutput?: boolean;
  maxCaptureOutputLength?: number;
  suppressOutput?: boolean;
  environment?: Record<string, string>;
  secretValues?: readonly string[];
  sessionLogPath?: string;
  sessionLabel?: string;
}

export interface CommandRunResult {
  exitCode: number;
  output?: string;
  errorOutput?: string;
}

export type RunCommand = (
  options: CommandRunOptions,
) => Promise<CommandRunResult>;

export class CommandRunAbortedError extends Error {
  constructor() {
    super("Command run aborted");
    this.name = "CommandRunAbortedError";
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
  maxCaptureOutputLength,
  suppressOutput,
  environment,
  secretValues,
  sessionLogPath,
  sessionLabel,
}) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CommandRunAbortedError());
      return;
    }

    if (sessionLogPath) {
      appendSessionSection(sessionLogPath, sessionLabel ?? "Command");

      appendSessionLog(
        sessionLogPath,
        redactSecrets(
          [`Working directory: ${cwd}`, `Command: ${command}`, ""].join("\n"),
          secretValues,
        ),
      );
    }

    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["inherit", "pipe", "pipe"],
      detached: process.platform !== "win32",
      ...(environment === undefined
        ? {}
        : { env: { ...process.env, ...environment } }),
    });

    let settled = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    const stdoutRedactor = createSecretRedactor(secretValues);
    const stderrRedactor = createSecretRedactor(secretValues);
    let outputFlushed = false;
    let capturedOutput: string | undefined;
    let capturedErrorOutput: string | undefined;

    function capture(
      text: string,
      current: string | undefined,
    ): string | undefined {
      if (captureOutput !== true || text.length === 0) return current;
      const limit =
        (maxCaptureOutputLength ?? MAX_EXTERNAL_DIAGNOSTIC_LENGTH) + 1;
      return `${current ?? ""}${text}`.slice(0, limit);
    }

    function writeOutput(text: string, stream: NodeJS.WriteStream): void {
      if (text.length === 0) {
        return;
      }

      if (sessionLogPath) {
        appendSessionLog(sessionLogPath, text);
      } else if (suppressOutput === true) {
        return;
      } else {
        stream.write(text);
      }
    }

    function flushOutput(): void {
      if (outputFlushed) {
        return;
      }

      outputFlushed = true;
      const stdout = stdoutRedactor.flush();
      const stderr = stderrRedactor.flush();
      writeOutput(stdout, process.stdout);
      writeOutput(stderr, process.stderr);
      capturedOutput = capture(stdout, capturedOutput);
      capturedErrorOutput = capture(stderr, capturedErrorOutput);
    }

    function settle(): void {
      settled = true;

      if (timeout !== undefined) {
        clearTimeout(timeout);
      }

      if (forceKillTimeout !== undefined) {
        clearTimeout(forceKillTimeout);
      }

      signal?.removeEventListener("abort", handleAbort);
    }

    function terminate(): void {
      if (settled) {
        return;
      }

      signalProcessTree(child.pid, "SIGTERM", (signal) => child.kill(signal));

      forceKillTimeout = setTimeout(() => {
        if (settled) {
          return;
        }

        signalProcessTree(child.pid, "SIGKILL", (signal) => child.kill(signal));
        flushOutput();
        settle();

        reject(
          timedOut
            ? new CommandTimeoutError(timeoutMilliseconds!)
            : new CommandRunAbortedError(),
        );
      }, commandTerminationGraceMilliseconds);
    }

    function handleAbort(): void {
      terminate();
    }

    if (signal) {
      signal.addEventListener("abort", handleAbort, { once: true });
    }

    if (timeoutMilliseconds !== undefined) {
      timeout = setTimeout(() => {
        if (settled) {
          return;
        }

        timedOut = true;
        terminate();
      }, timeoutMilliseconds);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      const redacted = stdoutRedactor.push(text);
      writeOutput(redacted, process.stdout);
      capturedOutput = capture(redacted, capturedOutput);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      const redacted = stderrRedactor.push(text);
      writeOutput(redacted, process.stderr);
      capturedErrorOutput = capture(redacted, capturedErrorOutput);
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }

      flushOutput();
      settle();

      reject(
        new Error(`Failed to start command: ${error.message}`, {
          cause: error,
        }),
      );
    });

    child.once("close", (code) => {
      if (settled) {
        return;
      }

      flushOutput();
      settle();

      if (timedOut) {
        reject(new CommandTimeoutError(timeoutMilliseconds!));
        return;
      }

      if (signal?.aborted) {
        reject(new CommandRunAbortedError());
        return;
      }

      resolve({
        exitCode: code ?? 1,
        ...(captureOutput === true
          ? {
              output: presentExternalDiagnostic(
                capturedOutput ?? "",
                secretValues,
                maxCaptureOutputLength,
              ),
              errorOutput: presentExternalDiagnostic(
                capturedErrorOutput ?? "",
                secretValues,
                maxCaptureOutputLength,
              ),
            }
          : {}),
      });
    });
  });

export class CommandRunner {
  constructor(private readonly runCommand: RunCommand = defaultRunCommand) {}

  run(options: CommandRunOptions): Promise<CommandRunResult> {
    return this.runCommand(options);
  }
}
