import { describe, expect, it, vi } from "vitest";

import {
  OpenCodeClient,
  OpenCodeRunAbortedError,
  OpenCodeTimeoutError,
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

  it("rejects with OpenCodeRunAbortedError when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const opencode = new OpenCodeClient();

    try {
      await opencode.run({
        cwd: "/tmp/repository",
        model: "test-model",
        variant: "test-variant",
        timeoutMilliseconds: 60_000,
        prompt: "Test prompt",
        signal: controller.signal,
      });

      throw new Error("Expected OpenCode run to abort");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenCodeRunAbortedError);
      expect((error as Error).message).toBe("OpenCode run aborted");
    }
  });

  it("uses OpenCodeTimeoutError for safety timeouts", () => {
    const error = new OpenCodeTimeoutError(123_000);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("OpenCodeTimeoutError");
    expect(error.message).toBe("OpenCode exceeded safety timeout of 123000ms");
  });
});
