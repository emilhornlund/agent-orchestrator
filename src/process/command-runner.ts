import { spawn } from "node:child_process";

export interface CommandRunOptions {
  cwd: string;
  command: string;
}

export interface CommandRunResult {
  exitCode: number;
}

export type RunCommand = (
  options: CommandRunOptions,
) => Promise<CommandRunResult>;

const defaultRunCommand: RunCommand = async ({ cwd, command }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: "inherit",
    });

    let settled = false;

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
