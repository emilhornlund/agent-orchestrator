import { describe, expect, it, vi } from "vitest";

import {
  OpenCodeClient,
  signalProcessTree,
  type RunOpenCode,
} from "../src/opencode/opencode-client.js";

describe("OpenCodeClient", () => {
  it("runs OpenCode with the provided options", async () => {
    const runOpenCode = vi.fn<RunOpenCode>().mockResolvedValue({
      exitCode: 0,
      output: "Completed",
    });

    const client = new OpenCodeClient(runOpenCode);

    const controller = new AbortController();

    const result = await client.run({
      cwd: "/worktree",
      model: "openai/gpt-5.6-luna",
      variant: "xhigh",
      timeoutMilliseconds: 360 * 60_000,
      prompt: "Implement the task",
      signal: controller.signal,
    });

    expect(runOpenCode).toHaveBeenCalledWith({
      cwd: "/worktree",
      model: "openai/gpt-5.6-luna",
      variant: "xhigh",
      timeoutMilliseconds: 360 * 60_000,
      prompt: "Implement the task",
      signal: controller.signal,
    });

    expect(result).toEqual({
      exitCode: 0,
      output: "Completed",
    });
  });

  it("signals the process group on non-Windows platforms", () => {
    if (process.platform === "win32") {
      return;
    }

    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const killChild = vi.fn(() => true);

    signalProcessTree(1234, "SIGTERM", killChild);

    expect(kill).toHaveBeenCalledWith(-1234, "SIGTERM");
    expect(killChild).not.toHaveBeenCalled();

    kill.mockRestore();
  });

  it("falls back to the child handle when the child pid is unavailable", () => {
    const killChild = vi.fn(() => true);

    signalProcessTree(undefined, "SIGTERM", killChild);

    expect(killChild).toHaveBeenCalledWith("SIGTERM");
  });

  it("ignores ESRCH when the process group is already gone", () => {
    if (process.platform === "win32") {
      return;
    }

    const error = Object.assign(new Error("No such process"), {
      code: "ESRCH",
    });

    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw error;
    });

    expect(() => {
      signalProcessTree(
        1234,
        "SIGTERM",
        vi.fn(() => true),
      );
    }).not.toThrow();

    kill.mockRestore();
  });
});
