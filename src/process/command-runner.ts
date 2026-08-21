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

    child.once("error", (error) => {
      reject(
        new Error(`Failed to start command: ${error.message}`, {
          cause: error,
        }),
      );
    });

    child.once("close", (code) => {
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
