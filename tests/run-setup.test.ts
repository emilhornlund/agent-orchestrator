import { describe, expect, it, vi } from "vitest";

import { WorkflowError } from "../src/orchestrator/workflow-error.js";
import {
  CommandRunAbortedError,
  CommandRunner,
  type RunCommand,
} from "../src/process/command-runner.js";
import { runRepositorySetup } from "../src/process/run-setup.js";

describe("runRepositorySetup", () => {
  it("executes the configured setup command through CommandRunner", async () => {
    const runCommand = vi.fn<RunCommand>().mockResolvedValue({ exitCode: 0 });
    const runner = new CommandRunner(runCommand);
    const signal = new AbortController().signal;

    await expect(
      runRepositorySetup(runner, {
        cwd: "/worktree",
        command: "yarn install",
        timeoutMilliseconds: 60_000,
        signal,
        sessionLogPath: "/logs/card.log",
        sessionLabel: "Repository setup",
      }),
    ).resolves.toEqual({ exitCode: 0 });

    expect(runCommand).toHaveBeenCalledWith({
      cwd: "/worktree",
      command: "yarn install",
      timeoutMilliseconds: 60_000,
      signal,
      sessionLogPath: "/logs/card.log",
      sessionLabel: "Repository setup",
    });
  });

  it("keeps command-runner setup errors in the Setup workflow category", async () => {
    const cause = new Error("dependency installation failed");
    const runCommand = vi.fn<RunCommand>().mockRejectedValue(cause);

    await expect(
      runRepositorySetup(new CommandRunner(runCommand), {
        cwd: "/worktree",
        command: "yarn install",
        timeoutMilliseconds: 60_000,
        sessionLogPath: "/logs/card.log",
        sessionLabel: "Repository setup",
      }),
    ).rejects.toMatchObject({
      name: "WorkflowError",
      category: "Setup",
      cause,
    } satisfies Partial<WorkflowError>);
  });

  it("does not convert an orchestrator shutdown into a setup failure", async () => {
    const runCommand = vi
      .fn<RunCommand>()
      .mockRejectedValue(new CommandRunAbortedError());

    await expect(
      runRepositorySetup(new CommandRunner(runCommand), {
        cwd: "/worktree",
        command: "yarn install",
        timeoutMilliseconds: 60_000,
        sessionLogPath: "/logs/card.log",
        sessionLabel: "Repository setup",
      }),
    ).rejects.toBeInstanceOf(CommandRunAbortedError);
  });
});
