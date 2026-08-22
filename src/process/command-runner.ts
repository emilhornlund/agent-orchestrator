import { spawn } from "node:child_process";

import {
  appendSessionLog,
  appendSessionSection,
} from "../logging/session-log.js";

export interface CommandRunOptions {
  cwd: string;
  command: string;
  sessionLogPath?: string;
  sessionLabel?: string;
}

export interface CommandRunResult {
  exitCode: number;
}

export type RunCommand = (
  options: CommandRunOptions,
) => Promise<CommandRunResult>;

const defaultRunCommand: RunCommand = async ({
  cwd,
  command,
  sessionLogPath,
  sessionLabel,
}) =>
  new Promise((resolve, reject) => {
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
    });

    let settled = false;

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

      settled = true;

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

      settled = true;

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
