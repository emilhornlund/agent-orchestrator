import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { CommandRunner, type RunCommand } from "../src/process/command-runner.js";
import {
  inspectPrimaryOpenCodeSession,
  OpenCodeSessionListError,
  parseOpenCodeSessionList,
} from "../src/opencode/inspect-primary-session.js";
import { configureProcessRuntime } from "../src/process/process-runtime.js";

describe("inspectPrimaryOpenCodeSession", () => {
  it("parses session identities and confirms only a session in the owned worktree", async () => {
    expect(
      parseOpenCodeSessionList(
        JSON.stringify([
          {
            id: "ses_primary",
            directory: "/tmp/worktrees/card",
            title: "task",
          },
        ]),
      ),
    ).toEqual([{ id: "ses_primary", directory: "/tmp/worktrees/card" }]);

    const run = vi.fn<RunCommand>().mockResolvedValue({
      exitCode: 0,
      output: JSON.stringify([
        { id: "ses_primary", directory: path.resolve("/tmp/worktrees/card") },
      ]),
    });
    await expect(
      inspectPrimaryOpenCodeSession({
        commands: new CommandRunner(run),
        cwd: "/tmp/worktrees/card",
        sessionId: "ses_primary",
        signal: new AbortController().signal,
        timeoutMilliseconds: 1_000,
      }),
    ).resolves.toBe("reachable");
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/worktrees/card",
        command: "opencode session list --format json --pure --max-count 10000",
        captureOutput: true,
      }),
    );

    run.mockResolvedValueOnce({
      exitCode: 0,
      output: JSON.stringify([{ id: "ses_primary", directory: "/tmp/other-worktree" }]),
    });
    await expect(
      inspectPrimaryOpenCodeSession({
        commands: new CommandRunner(run),
        cwd: "/tmp/worktrees/card",
        sessionId: "ses_primary",
        signal: new AbortController().signal,
        timeoutMilliseconds: 1_000,
      }),
    ).resolves.toBe("conflict");
  });

  it("fails closed on malformed, inaccessible, and ambiguous session listings", async () => {
    const marker = "SESSION_STDOUT_PRIVATE_CANARY_4A91";
    let malformed: unknown;
    try {
      parseOpenCodeSessionList(`{${marker}`);
    } catch (error) {
      malformed = error;
    }
    expect(malformed).toBeInstanceOf(Error);
    expect((malformed as Error).message).toContain("valid JSON");
    expect((malformed as Error).message).not.toContain(marker);
    expect((malformed as Error).cause).toBeUndefined();
    expect(() => parseOpenCodeSessionList("[{}]")).toThrow("malformed");

    const run = vi.fn<RunCommand>().mockResolvedValue({
      exitCode: 0,
      output: JSON.stringify([
        { id: "ses_primary", directory: "/tmp/worktree" },
        { id: "ses_primary", directory: "/tmp/worktree" },
      ]),
    });
    const inspect = (sessionId = "ses_primary") =>
      inspectPrimaryOpenCodeSession({
        commands: new CommandRunner(run),
        cwd: "/tmp/worktree",
        sessionId,
        signal: new AbortController().signal,
        timeoutMilliseconds: 1_000,
      });
    await expect(inspect()).resolves.toBe("conflict");
    run.mockRejectedValueOnce(new Error("command unavailable"));
    await expect(inspect()).resolves.toBe("unknown");
    await expect(inspect("invalid/session")).resolves.toBe("unknown");
  });

  it("keeps malformed real child output private while attaching process artifact references", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-list-evidence-"));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const marker = "SESSION_JSON_RAW_CANARY_7C52";
    const executable = path.join(bin, "opencode");
    fs.writeFileSync(executable, `#!/bin/sh\nprintf '{${marker}'\n`);
    fs.chmodSync(executable, 0o700);
    const priorPath = process.env.PATH;
    try {
      process.env.PATH = `${bin}${path.delimiter}${priorPath ?? ""}`;
      configureProcessRuntime({
        runtimeRoot: root,
        signal: new AbortController().signal,
      });
      let failure: unknown;
      try {
        await inspectPrimaryOpenCodeSession({
          commands: new CommandRunner(),
          cwd: root,
          sessionId: "ses_primary",
          signal: new AbortController().signal,
          timeoutMilliseconds: 5_000,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(OpenCodeSessionListError);
      expect(failure).toMatchObject({
        executionId: expect.stringMatching(/^[0-9a-f-]{36}$/iu),
        stdoutArtifactReference: expect.stringMatching(
          /^process-executions\/[0-9a-f-]+\/stdout\.txt$/,
        ),
      });
      expect((failure as Error).message).not.toContain(marker);
      expect((failure as Error).cause).toBeUndefined();
      const error = failure as OpenCodeSessionListError;
      const stdout = fs.readFileSync(path.join(root, error.stdoutArtifactReference!), "utf8");
      expect(stdout).toContain(marker);
      expect((failure as Error).message).toContain("valid JSON");
    } finally {
      process.env.PATH = priorPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
