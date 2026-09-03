import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import {
  CommandRunAbortedError,
  CommandTimeoutError,
  CommandRunner,
  type RunCommand,
} from "../src/process/command-runner.js";

interface FakeChild extends EventEmitter {
  pid?: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: NodeJS.Signals | number) => boolean;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;

  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);

  return child;
}

describe("CommandRunner", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

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

  it("runs the default command runner with a shell", async () => {
    const child = createFakeChild();

    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    const runner = new CommandRunner();

    await expect(
      runner.run({
        cwd: "/worktree",
        command: "yarn validate",
      }),
    ).resolves.toEqual({ exitCode: 0 });

    expect(spawnMock).toHaveBeenCalledWith("yarn validate", {
      cwd: "/worktree",
      shell: true,
      stdio: ["inherit", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
  });

  it("passes operation credentials to the child and redacts command output", async () => {
    const child = createFakeChild();
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("to"));
        child.stdout.emit("data", Buffer.from("ken-a\n"));
        child.emit("close", 0);
      });
      return child;
    });

    const runner = new CommandRunner();

    await runner.run({
      cwd: "/worktree",
      command: "gh repo clone owner/repository /repo",
      environment: { GH_TOKEN: "token-a" },
      secretValues: ["token-a"],
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "gh repo clone owner/repository /repo",
      {
        cwd: "/worktree",
        shell: true,
        stdio: ["inherit", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: expect.objectContaining({ GH_TOKEN: "token-a" }),
      },
    );
    expect(stdoutWrite).toHaveBeenCalledWith("[REDACTED]\n");
  });

  it("terminates and rejects a command that exceeds its timeout", async () => {
    vi.useFakeTimers();

    const child = createFakeChild();
    spawnMock.mockReturnValueOnce(child);

    const runner = new CommandRunner();
    const request = runner.run({
      cwd: "/worktree",
      command: "yarn validate",
      timeoutMilliseconds: 1_000,
    });
    const rejection =
      expect(request).rejects.toBeInstanceOf(CommandTimeoutError);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    await rejection;

    vi.useRealTimers();
  });

  it("rejects an aborted command without moving workflow state", async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValueOnce(child);

    const controller = new AbortController();
    const runner = new CommandRunner();
    const request = runner.run({
      cwd: "/worktree",
      command: "yarn validate",
      signal: controller.signal,
    });

    controller.abort();
    child.emit("close", null);

    await expect(request).rejects.toBeInstanceOf(CommandRunAbortedError);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
