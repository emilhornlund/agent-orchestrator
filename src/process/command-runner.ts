import { spawn } from "node:child_process";

import {
  appendSessionLog,
  appendSessionSection,
} from "../logging/session-log.js";

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
  sessionLogPath?: string;
  sessionLabel?: string;
}

export interface CommandRunResult {
  exitCode: number;
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
        [`Working directory: ${cwd}`, `Command: ${command}`, ""].join("\n"),
      );
    }

    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["inherit", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let settled = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;

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

      if (sessionLogPath) {
        appendSessionLog(sessionLogPath, text);
      } else {
        process.stdout.write(text);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();

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
      });
    });
  });

export class CommandRunner {
  constructor(private readonly runCommand: RunCommand = defaultRunCommand) {}

  run(options: CommandRunOptions): Promise<CommandRunResult> {
    return this.runCommand(options);
  }
}
