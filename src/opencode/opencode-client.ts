import { spawn } from "node:child_process";

export interface OpenCodeRunOptions {
  cwd: string;
  model: string;
  variant: string;
  prompt: string;
}

export interface OpenCodeRunResult {
  exitCode: number;
  output: string;
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
        stdio: ["inherit", "pipe", "pipe"],
      },
    );

    let output = "";
    let settled = false;

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;

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

      resolve({
        exitCode: code ?? 1,
        output,
      });
    });
  });

export class OpenCodeClient {
  constructor(private readonly runOpenCode: RunOpenCode = defaultRunOpenCode) {}

  run(options: OpenCodeRunOptions): Promise<OpenCodeRunResult> {
    return this.runOpenCode(options);
  }
}
