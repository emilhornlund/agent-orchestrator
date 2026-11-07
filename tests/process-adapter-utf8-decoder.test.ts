import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { GitClient } from "../src/git/git-client.js";
import { GitHubClient } from "../src/github/github-client.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { configureProcessRuntime } from "../src/process/process-runtime.js";

const secret = "秘密🔐";
const runtimeRoots: string[] = [];

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid: undefined,
    kill: vi.fn(() => true),
  });
}

function writeBytewise(
  child: ReturnType<typeof fakeChild>,
  stdout: Buffer,
  stderr: Buffer,
) {
  const count = Math.max(stdout.length, stderr.length);
  for (let index = 0; index < count; index += 1) {
    if (index < stdout.length)
      child.stdout.emit("data", Buffer.from([stdout[index]!]));
    if (index < stderr.length)
      child.stderr.emit("data", Buffer.from([stderr[index]!]));
  }
  child.emit("close", 0, null);
}

afterEach(() => {
  spawnMock.mockReset();
  configureProcessRuntime({
    runtimeRoot: os.tmpdir(),
    signal: new AbortController().signal,
    secretValues: [],
  });
  for (const root of runtimeRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("adapter UTF-8 decoding at deterministic chunk boundaries", () => {
  it.each(["git", "gh", "opencode"] as const)(
    "%s decodes independent one-byte streams before redaction and finalizes incomplete UTF-8",
    async (family) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-utf8-unit-"));
      runtimeRoots.push(root);
      const runtimeRoot = path.join(root, "runtime");
      configureProcessRuntime({
        runtimeRoot,
        signal: new AbortController().signal,
        secretValues: [secret],
      });

      const url = `https://github.com/owner/repository/pull/123?q=${secret}`;
      const stdout = Buffer.concat([
        Buffer.from(
          family === "gh" ? url : `stdout: café:${secret}:終\n`,
          "utf8",
        ),
        ...(family === "gh" ? [] : [Buffer.from([0xe2, 0x82])]),
      ]);
      const stderr = Buffer.concat([
        Buffer.from(`stderr: λ:${secret}:雪\n`, "utf8"),
        Buffer.from([0xf0, 0x9f]),
      ]);
      const child = fakeChild();
      spawnMock.mockImplementationOnce(() => {
        queueMicrotask(() => writeBytewise(child, stdout, stderr));
        return child;
      });

      const result =
        family === "git"
          ? await new GitClient().getCurrentBranch(root)
          : family === "gh"
            ? await new GitHubClient().findPullRequest({
                cwd: root,
                repository: "owner/repository",
                headBranch: "agent/utf8",
              })
            : await new OpenCodeClient().run({
                cwd: root,
                model: "test/model",
                variant: "test",
                prompt: "utf8 test",
                signal: new AbortController().signal,
                timeoutMilliseconds: 10_000,
              });

      if (family === "gh")
        expect(result).toEqual({
          url: "https://github.com/owner/repository/pull/123?q=[REDACTED]",
        });
      else if (family === "git")
        expect(result).toBe(`stdout: café:[REDACTED]:終\n�`);
      else
        expect(result).toMatchObject({
          exitCode: 0,
          output: `stdout: café:[REDACTED]:終\n�`,
          errorOutput: `stderr: λ:[REDACTED]:雪\n�`,
        });

      const executionRoot = path.join(runtimeRoot, "process-executions");
      const [executionId] = fs.readdirSync(executionRoot);
      expect(executionId).toMatch(/^[0-9a-f-]{36}$/iu);
      const executionDirectory = path.join(executionRoot, executionId!);
      const capturedStdout = fs.readFileSync(
        path.join(executionDirectory, "stdout.txt"),
        "utf8",
      );
      const capturedStderr = fs.readFileSync(
        path.join(executionDirectory, "stderr.txt"),
        "utf8",
      );
      expect(capturedStdout).toBe(
        family === "gh"
          ? "https://github.com/owner/repository/pull/123?q=[REDACTED]"
          : `stdout: café:[REDACTED]:終\n�`,
      );
      expect(capturedStderr).toBe(`stderr: λ:[REDACTED]:雪\n�`);
      expect(capturedStdout).not.toContain(secret);
      expect(capturedStderr).not.toContain(secret);
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(executionDirectory, "execution.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ executionId, status: "success" });
    },
  );
});
