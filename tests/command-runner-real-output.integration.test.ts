import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CommandRunner } from "../src/process/command-runner.js";
import { ProcessOutputLimitError } from "../src/process/process-runtime.js";

describe("CommandRunner actual child output bounds", () => {
  it("rejects actual output beyond the complete-capture bound, even on zero exit after TERM", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "command-output-bound-"),
    );
    const termMarker = path.join(root, "term-handled.txt");
    const script = [
      'const fs=require("node:fs");',
      `process.on("SIGTERM",()=>{fs.writeFileSync(${JSON.stringify(termMarker)},"handled");fs.writeSync(1,"TERM-STDOUT\\n");fs.writeSync(2,"TERM-STDERR\\n");process.exit(0)});`,
      "setInterval(()=>{},1000);",
      `process.stdout.write(Buffer.alloc(${16 * 1024 * 1024 + 1},120));`,
    ].join("");
    const command = `exec node -e '${script}'`;
    try {
      await expect(
        new CommandRunner().run({
          cwd: root,
          command,
          captureOutput: true,
          capturePolicy: "complete",
          suppressOutput: true,
          artifactDirectory: path.join(root, "artifacts"),
          timeoutMilliseconds: 30_000,
        }),
      ).rejects.toBeInstanceOf(ProcessOutputLimitError);
      expect(fs.readFileSync(termMarker, "utf8")).toBe("handled");
      const [executionId] = fs.readdirSync(path.join(root, "artifacts"));
      expect(executionId).toBeDefined();
      const executionDirectory = path.join(root, "artifacts", executionId!);
      const metadata = JSON.parse(
        fs.readFileSync(
          path.join(executionDirectory, "execution.json"),
          "utf8",
        ),
      ) as { status: string; exitCode?: number };
      expect(metadata).toMatchObject({
        status: "evidence-failure",
        exitCode: 0,
      });
      expect(
        fs.readFileSync(path.join(executionDirectory, "stdout.txt"), "utf8"),
      ).toContain("TERM-STDOUT\n");
      expect(
        fs.readFileSync(path.join(executionDirectory, "stderr.txt"), "utf8"),
      ).toContain("TERM-STDERR\n");
      expect(
        fs.readFileSync(path.join(executionDirectory, "stdout.txt"), "utf8"),
      ).not.toContain("TERM-STDERR");
      expect(
        fs.readFileSync(path.join(executionDirectory, "stderr.txt"), "utf8"),
      ).not.toContain("TERM-STDOUT");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
