import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CommandRunner,
  type RunCommand,
} from "../src/process/command-runner.js";
import {
  inspectPrimaryOpenCodeSession,
  parseOpenCodeSessionList,
} from "../src/opencode/inspect-primary-session.js";

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
    ).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/worktrees/card",
        command: "opencode session list --format json --pure --max-count 10000",
        captureOutput: true,
      }),
    );

    run.mockResolvedValueOnce({
      exitCode: 0,
      output: JSON.stringify([
        { id: "ses_primary", directory: "/tmp/other-worktree" },
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
    ).resolves.toBe(false);
  });

  it("fails closed on malformed, inaccessible, and ambiguous session listings", async () => {
    expect(() => parseOpenCodeSessionList("{bad")).toThrow("valid JSON");
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
    await expect(inspect()).resolves.toBe(null);
    run.mockRejectedValueOnce(new Error("command unavailable"));
    await expect(inspect()).resolves.toBe(null);
    await expect(inspect("invalid/session")).resolves.toBe(null);
  });
});
