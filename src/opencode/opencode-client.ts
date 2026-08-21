import { spawn } from "node:child_process";

export interface OpenCodeRunOptions {
  cwd: string;
  model: string;
  variant: string;
  prompt: string;
}

export interface OpenCodeRunResult {
  exitCode: number;
}

export type RunOpenCode = (
  options: OpenCodeRunOptions,
) => Promise<OpenCodeRunResult>;

const defaultRunOpenCode: RunOpenCode = async ({
  cwd,
  model,
  variant,
  prompt,
}) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "opencode",
      ["run", "--model", model, "--variant", variant, "--dir", cwd, prompt],
      {
        cwd,
        stdio: "inherit",
      },
    );

    child.once("error", (error) => {
      reject(
        new Error(`Failed to start OpenCode: ${error.message}`, {
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

export class OpenCodeClient {
  constructor(private readonly runOpenCode: RunOpenCode = defaultRunOpenCode) {}

  run(options: OpenCodeRunOptions): Promise<OpenCodeRunResult> {
    return this.runOpenCode(options);
  }
}
