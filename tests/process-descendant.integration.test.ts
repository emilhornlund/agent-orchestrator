import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { CommandRunner } from "../src/process/command-runner.js";
import { GitClient } from "../src/git/git-client.js";
import { GitHubClient } from "../src/github/github-client.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { configureProcessRuntime } from "../src/process/process-runtime.js";
import { drainProcessGroup } from "../src/process/process-runtime.js";
import { PROCESS_EVIDENCE_MAX_BYTES } from "../src/process/process-runtime.js";

function expectNoLiveProcessGroup(pid: number): void {
  if (process.platform === "linux") {
    const liveMembers: string[] = [];
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/u.test(entry)) continue;
      let stat: string;
      try {
        stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ESRCH")
        )
          continue;
        throw error;
      }
      const closeParen = stat.lastIndexOf(")");
      if (closeParen < 0)
        throw new Error(
          `Malformed /proc/${entry}/stat during process-group inspection`,
        );
      const fields = stat.slice(closeParen + 2).split(" ");
      const state = fields[0];
      const processGroup = Number(fields[2]);
      if (!state || !Number.isSafeInteger(processGroup) || processGroup < 0)
        throw new Error(`Malformed /proc/${entry}/stat process-group fields`);
      if (processGroup === pid && state !== "Z" && state !== "X")
        liveMembers.push(entry);
    }
    expect(liveMembers).toEqual([]);
    return;
  }
  expect(() => process.kill(-pid, 0)).toThrow();
}

describe("managed process descendants", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("terminates a surviving descendant when the command leader exits", async () => {
    const artifactDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "process-descendant-test-"),
    );
    directories.push(artifactDirectory);
    const runner = new CommandRunner();
    const command = `node -e 'require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" }).unref()'`;

    await expect(
      runner.run({ cwd: process.cwd(), command, artifactDirectory }),
    ).resolves.toEqual({ exitCode: 0 });

    const [executionId] = fs.readdirSync(artifactDirectory);
    expect(executionId).toBeDefined();
    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(artifactDirectory, executionId!, "execution.json"),
        "utf8",
      ),
    ) as { pid: number; status: string };
    expect(metadata.status).toBe("success");

    // Close the race where a descendant closes inherited pipes then outlives its leader.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expectNoLiveProcessGroup(metadata.pid);
  }, 10_000);

  it("does not settle while a SIGTERM-resistant pipe-closed descendant can write", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "process-sentinel-test-"),
    );
    directories.push(directory);
    const sentinel = path.join(directory, "sentinel");
    const leader = spawn(
      process.execPath,
      [
        "-e",
        `const {spawn}=require("node:child_process"); spawn(process.execPath,["-e",${JSON.stringify(`process.on('SIGTERM',()=>{}); const fs=require('node:fs'); setInterval(()=>fs.appendFileSync(${JSON.stringify(sentinel)},'x'),10);`)}],{stdio:"ignore"}).unref();`,
      ],
      { detached: true, stdio: "ignore" },
    );
    if (leader.pid === undefined) throw new Error("leader has no pid");
    await new Promise<void>((resolve, reject) => {
      leader.once("error", reject);
      leader.once("close", () => resolve());
    });
    const writeDeadline = Date.now() + 2_000;
    while (!fs.existsSync(sentinel) && Date.now() < writeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fs.existsSync(sentinel)).toBe(true);

    await drainProcessGroup(leader.pid, (signal) => leader.kill(signal), 100);
    const bytesAtSettlement = fs.statSync(sentinel).size;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fs.statSync(sentinel).size).toBe(bytesAtSettlement);
  }, 5_000);

  it("captures evidence and cleans descendant groups for Git, gh and OpenCode", async () => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "process-families-"),
    );
    directories.push(runtimeRoot);
    const binaries = path.join(runtimeRoot, "bin");
    fs.mkdirSync(binaries);
    const script = `#!/usr/bin/env node\nif (process.argv[1].endsWith("/git")) process.stdout.write("git-status\\n");\nelse if (process.argv[1].endsWith("/opencode")) process.stdout.write("opencode-output\\n");\n`;
    for (const executable of ["git", "gh", "opencode"]) {
      const filename = path.join(binaries, executable);
      fs.writeFileSync(filename, script, { mode: 0o700 });
      fs.chmodSync(filename, 0o700);
    }
    const originalPath = process.env.PATH;
    process.env.PATH = `${binaries}${path.delimiter}${originalPath ?? ""}`;
    const controller = new AbortController();
    configureProcessRuntime({ runtimeRoot, signal: controller.signal });
    try {
      await expect(new GitClient().getStatus(process.cwd())).resolves.toBe(
        "git-status",
      );
      await expect(
        new GitHubClient().findPullRequest({
          cwd: process.cwd(),
          repository: "owner/repository",
          headBranch: "agent/test",
        }),
      ).resolves.toBeNull();
      await expect(
        new OpenCodeClient().run({
          cwd: process.cwd(),
          model: "test/model",
          variant: "test",
          timeoutMilliseconds: 5_000,
          prompt: "test prompt",
          signal: controller.signal,
        }),
      ).resolves.toMatchObject({ exitCode: 0, output: "opencode-output\n" });

      const executionsRoot = path.join(runtimeRoot, "process-executions");
      const executionDirectories = fs.readdirSync(executionsRoot);
      expect(executionDirectories).toHaveLength(3);
      for (const directoryName of executionDirectories) {
        const evidence = JSON.parse(
          fs.readFileSync(
            path.join(executionsRoot, directoryName, "execution.json"),
            "utf8",
          ),
        ) as {
          pid: number;
          status: string;
          stdoutArtifact: string;
          stderrArtifact: string;
        };
        expect(evidence.status).toBe("success");
        expect(fs.existsSync(evidence.stdoutArtifact)).toBe(true);
        expect(fs.existsSync(evidence.stderrArtifact)).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expectNoLiveProcessGroup(evidence.pid);
      }
    } finally {
      process.env.PATH = originalPath;
      configureProcessRuntime({
        runtimeRoot: os.tmpdir(),
        signal: new AbortController().signal,
      });
    }
  }, 20_000);

  it("keeps nonzero Git and gh stderr in execution artifacts, not public errors", async () => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "safe-process-errors-"),
    );
    directories.push(runtimeRoot);
    const binaries = path.join(runtimeRoot, "bin");
    fs.mkdirSync(binaries);
    const marker = "ACTUAL_PRIVATE_STDERR_MARKER_7b64";
    const script = `#!/usr/bin/env node\nprocess.stderr.write(${JSON.stringify(marker)}); process.exit(7);\n`;
    for (const executable of ["git", "gh"]) {
      const filename = path.join(binaries, executable);
      fs.writeFileSync(filename, script, { mode: 0o700 });
      fs.chmodSync(filename, 0o700);
    }
    const originalPath = process.env.PATH;
    process.env.PATH = `${binaries}${path.delimiter}${originalPath ?? ""}`;
    configureProcessRuntime({
      runtimeRoot,
      signal: new AbortController().signal,
    });
    try {
      const errors: Error[] = [];
      await new GitClient().getStatus(process.cwd()).catch((error: unknown) => {
        if (error instanceof Error) errors.push(error);
      });
      await new GitHubClient()
        .findPullRequest({
          cwd: process.cwd(),
          repository: "owner/repository",
          headBranch: "agent/test",
        })
        .catch((error: unknown) => {
          if (error instanceof Error) errors.push(error);
        });
      expect(errors).toHaveLength(2);
      for (const error of errors) {
        expect(error.message).toContain("process-executions/");
        expect(error.message).not.toContain(marker);
        expect(JSON.stringify(error)).not.toContain(marker);
      }
      const executionDirectories = fs.readdirSync(
        path.join(runtimeRoot, "process-executions"),
      );
      expect(executionDirectories).toHaveLength(2);
      for (const executionId of executionDirectories) {
        expect(
          fs.readFileSync(
            path.join(
              runtimeRoot,
              "process-executions",
              executionId,
              "stderr.txt",
            ),
            "utf8",
          ),
        ).toContain(marker);
        const metadata = JSON.parse(
          fs.readFileSync(
            path.join(
              runtimeRoot,
              "process-executions",
              executionId,
              "execution.json",
            ),
            "utf8",
          ),
        ) as { status: string; exitCode: number };
        expect(metadata).toMatchObject({ status: "nonzero", exitCode: 7 });
      }
    } finally {
      process.env.PATH = originalPath;
      configureProcessRuntime({
        runtimeRoot: os.tmpdir(),
        signal: new AbortController().signal,
      });
    }
  }, 10_000);

  it.each([0, 7])(
    "flushes and redacts exact no-newline Git and gh output on exit %s",
    async (exitCode) => {
      const runtimeRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "partial-process-evidence-"),
      );
      directories.push(runtimeRoot);
      const binaries = path.join(runtimeRoot, "bin");
      fs.mkdirSync(binaries);
      const script = `#!/usr/bin/env node\nif (process.argv[1].endsWith("/gh")) { process.stdout.write("{\\"body\\":\\"before sensitive-"); process.stdout.write("token after\\"}"); } else { process.stdout.write("before sensitive-"); process.stdout.write("token after"); } process.exit(${exitCode});\n`;
      for (const executable of ["git", "gh"]) {
        const filename = path.join(binaries, executable);
        fs.writeFileSync(filename, script, { mode: 0o700 });
      }
      const originalPath = process.env.PATH;
      process.env.PATH = `${binaries}${path.delimiter}${originalPath ?? ""}`;
      configureProcessRuntime({
        runtimeRoot,
        signal: new AbortController().signal,
        secretValues: ["sensitive-token"],
      });
      try {
        if (exitCode === 0) {
          await expect(new GitClient().getStatus(process.cwd())).resolves.toBe(
            "before [REDACTED] after",
          );
          await expect(
            new GitHubClient().getPullRequestDescription({
              cwd: process.cwd(),
              repository: "owner/repository",
              pullRequestUrl: "https://github.com/owner/repository/pull/1",
            }),
          ).resolves.toBe("before [REDACTED] after");
        } else {
          await expect(
            new GitClient().getStatus(process.cwd()),
          ).rejects.toThrow();
          await expect(
            new GitHubClient().getPullRequestDescription({
              cwd: process.cwd(),
              repository: "owner/repository",
              pullRequestUrl: "https://github.com/owner/repository/pull/1",
            }),
          ).rejects.toThrow();
        }
        const executionRoot = path.join(runtimeRoot, "process-executions");
        const executions = fs.readdirSync(executionRoot);
        expect(executions).toHaveLength(2);
        for (const id of executions) {
          const metadata = JSON.parse(
            fs.readFileSync(
              path.join(executionRoot, id, "execution.json"),
              "utf8",
            ),
          ) as { command: string; status: string; exitCode: number };
          expect(
            fs.readFileSync(path.join(executionRoot, id, "stdout.txt"), "utf8"),
          ).toBe(
            metadata.command.startsWith("gh ")
              ? '{"body":"before [REDACTED] after"}'
              : "before [REDACTED] after",
          );
          expect(metadata).toMatchObject({
            status: exitCode === 0 ? "success" : "nonzero",
            exitCode,
          });
        }
      } finally {
        process.env.PATH = originalPath;
        configureProcessRuntime({
          runtimeRoot: os.tmpdir(),
          signal: new AbortController().signal,
        });
      }
    },
  );

  it("rejects GitHub evidence overflow even when SIGTERM makes gh exit zero", async () => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "gh-evidence-overflow-"),
    );
    directories.push(runtimeRoot);
    const binaries = path.join(runtimeRoot, "bin");
    fs.mkdirSync(binaries);
    const filename = path.join(binaries, "gh");
    fs.writeFileSync(
      filename,
      `#!/usr/bin/env node\nprocess.on("SIGTERM", () => process.exit(0)); process.stdout.write(Buffer.alloc(${PROCESS_EVIDENCE_MAX_BYTES + 1}, 120));\n`,
      { mode: 0o700 },
    );
    const originalPath = process.env.PATH;
    process.env.PATH = `${binaries}${path.delimiter}${originalPath ?? ""}`;
    configureProcessRuntime({
      runtimeRoot,
      signal: new AbortController().signal,
    });
    try {
      await expect(
        new GitHubClient().findPullRequest({
          cwd: process.cwd(),
          repository: "owner/repository",
          headBranch: "agent/test",
        }),
      ).rejects.toThrow(
        "Process stdout exceeded the 16777216-byte output limit",
      );
      const executionRoot = path.join(runtimeRoot, "process-executions");
      const [id] = fs.readdirSync(executionRoot);
      expect(id).toBeDefined();
      const metadata = JSON.parse(
        fs.readFileSync(
          path.join(executionRoot, id!, "execution.json"),
          "utf8",
        ),
      ) as { status: string; exitCode: number };
      expect(metadata).toMatchObject({
        status: "evidence-failure",
        exitCode: 0,
      });
    } finally {
      process.env.PATH = originalPath;
      configureProcessRuntime({
        runtimeRoot: os.tmpdir(),
        signal: new AbortController().signal,
      });
    }
  }, 20_000);

  it("aborts actual Git, gh and OpenCode process trees through runtime lifecycle", async () => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "process-abort-"),
    );
    directories.push(runtimeRoot);
    const binaries = path.join(runtimeRoot, "bin");
    fs.mkdirSync(binaries);
    const script = `#!/usr/bin/env node\nconst { spawn } = require("node:child_process");\nspawn(process.execPath, ["-e", "setInterval(() => {}, 30000)"], { stdio: "ignore" }).unref();\nsetInterval(() => {}, 30000);\n`;
    for (const executable of ["git", "gh", "opencode"]) {
      const filename = path.join(binaries, executable);
      fs.writeFileSync(filename, script, { mode: 0o700 });
      fs.chmodSync(filename, 0o700);
    }
    const originalPath = process.env.PATH;
    process.env.PATH = `${binaries}${path.delimiter}${originalPath ?? ""}`;
    try {
      const cases = [
        {
          name: "Git",
          invoke: (signal: AbortSignal) => {
            configureProcessRuntime({ runtimeRoot, signal });
            return new GitClient().getStatus(process.cwd());
          },
        },
        {
          name: "GitHub CLI",
          invoke: (signal: AbortSignal) => {
            configureProcessRuntime({ runtimeRoot, signal });
            return new GitHubClient().findPullRequest({
              cwd: process.cwd(),
              repository: "owner/repository",
              headBranch: "agent/test",
            });
          },
        },
        {
          name: "OpenCode",
          invoke: (signal: AbortSignal) => {
            configureProcessRuntime({ runtimeRoot, signal });
            return new OpenCodeClient().run({
              cwd: process.cwd(),
              model: "test/model",
              variant: "test",
              timeoutMilliseconds: 10_000,
              prompt: "test prompt",
              signal,
            });
          },
        },
      ];
      for (const testCase of cases) {
        const controller = new AbortController();
        const request = testCase.invoke(controller.signal);
        setTimeout(() => controller.abort("integration-test"), 100);
        await expect(request, testCase.name).rejects.toBeDefined();
      }
      const executionsRoot = path.join(runtimeRoot, "process-executions");
      const executionDirectories = fs.readdirSync(executionsRoot);
      expect(executionDirectories).toHaveLength(3);
      for (const directoryName of executionDirectories) {
        const evidence = JSON.parse(
          fs.readFileSync(
            path.join(executionsRoot, directoryName, "execution.json"),
            "utf8",
          ),
        ) as { pid: number; status: string };
        expect(evidence.status).toBe("interrupted");
        await new Promise((resolve) => setTimeout(resolve, 100));
        expectNoLiveProcessGroup(evidence.pid);
      }
    } finally {
      process.env.PATH = originalPath;
      configureProcessRuntime({
        runtimeRoot: os.tmpdir(),
        signal: new AbortController().signal,
      });
    }
  }, 20_000);
});
