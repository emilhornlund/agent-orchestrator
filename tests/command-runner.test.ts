import { describe, expect, it, vi } from "vitest";

import {
  CommandRunner,
  type RunCommand,
} from "../src/process/command-runner.js";

describe("CommandRunner", () => {
  it("runs a command in the provided working directory", async () => {
    const runCommand = vi.fn<RunCommand>().mockResolvedValue({
      exitCode: 0,
    });

    const runner = new CommandRunner(runCommand);

    const result = await runner.run({
      cwd: "/worktree",
      command: "yarn validate",
    });

    expect(runCommand).toHaveBeenCalledWith({
      cwd: "/worktree",
      command: "yarn validate",
    });

    expect(result).toEqual({
      exitCode: 0,
    });
  });
});
