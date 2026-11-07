import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { PROCESS_EVIDENCE_MAX_BYTES } from "../src/process/process-runtime.js";

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
  const temporaryDirectories: string[] = [];

  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
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
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(spawnMock).toHaveBeenCalledWith("yarn validate", {
      cwd: "/worktree",
      shell: true,
      stdio: ["inherit", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: expect.objectContaining({
        PATH: process.env.PATH,
        HOME: process.env.HOME,
      }),
    });
  });

  it("captures validation stdout and stderr in the card session log", async () => {
    const child = createFakeChild();
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-orchestrator-command-runner-"),
    );
    temporaryDirectories.push(temporaryDirectory);
    const sessionLogPath = path.join(temporaryDirectory, "card.log");
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("test suite output token-a\n"));
        child.stderr.emit(
          "data",
          Buffer.from("application log output token-a\n"),
        );
        child.emit("close", 0);
      });
      return child;
    });

    await expect(
      new CommandRunner().run({
        cwd: "/worktree",
        command: "yarn validate",
        sessionLogPath,
        sessionLabel: "Repository validation",
        secretValues: ["token-a"],
      }),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
    const sessionLog = fs.readFileSync(sessionLogPath, "utf8");

    expect(sessionLog).toContain(
      "test suite output [REDACTED]\napplication log output [REDACTED]\n",
    );
    expect(sessionLog).not.toContain("token-a");
  });

  it("can capture private command output without writing it to process streams", async () => {
    const child = createFakeChild();
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify([
              {
                id: "ses_primary",
                directory: "/worktree",
                title: "session ".repeat(400),
              },
            ]),
          ),
        );
        child.emit("close", 0);
      });
      return child;
    });

    try {
      const result = await new CommandRunner().run({
        cwd: "/worktree",
        command: "opencode session list --format json --pure",
        captureOutput: true,
        maxCaptureOutputLength: 4_096,
        suppressOutput: true,
      });
      expect(result.output).toContain('"id":"ses_primary"');
      expect(result.output?.length).toBeGreaterThan(2_000);
      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(stderrWrite).not.toHaveBeenCalled();
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }
  });

  it("summarizes verbose captured output without terminating the command", async () => {
    const child = createFakeChild();
    const artifactDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "verbose-command-artifacts-"),
    );
    temporaryDirectories.push(artifactDirectory);
    const longOutput = `${"output token-a ".repeat(300)}\n`;
    const longErrorOutput = `${"warning token-a ".repeat(300)}\n`;

    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(longOutput));
        child.stderr.emit("data", Buffer.from(longErrorOutput));
        child.emit("close", 9);
      });
      return child;
    });

    const result = new CommandRunner().run({
      cwd: "/worktree",
      command: "yarn validate",
      captureOutput: true,
      secretValues: ["token-a"],
      artifactDirectory,
    });
    await expect(result).resolves.toMatchObject({ exitCode: 9 });
    const resolved = await result;
    expect(resolved.output).toHaveLength(2_000);
    expect(resolved.output).toContain("[truncated]");
    expect(resolved.errorOutput).toHaveLength(2_000);
    expect(resolved.errorOutput).toContain("[truncated]");
    expect(child.kill).not.toHaveBeenCalled();
    const [executionId] = fs.readdirSync(artifactDirectory);
    expect(executionId).toBeDefined();
    const executionDirectory = path.join(artifactDirectory, executionId!);
    expect(
      fs.readFileSync(path.join(executionDirectory, "stdout.txt"), "utf8"),
    ).toContain("output [REDACTED]");
    expect(
      fs.readFileSync(path.join(executionDirectory, "stderr.txt"), "utf8"),
    ).toContain("warning [REDACTED]");
  });

  it("returns complete Unicode output to machine-readable callers", async () => {
    const child = createFakeChild();
    const output = "✓🙂".repeat(800);
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(output));
        child.emit("close", 0);
      });
      return child;
    });
    const result = await new CommandRunner().run({
      cwd: "/worktree",
      command: "machine-readable",
      captureOutput: true,
      capturePolicy: "complete",
      suppressOutput: true,
    });
    expect(result.output).toBe(output);
  });

  it("decodes a multibyte character split across every child chunk boundary", async () => {
    const child = createFakeChild();
    const expected = "prefix🙂é終suffix";
    const expectedError = "error✓漢🙂done";
    const bytes = Buffer.from(expected);
    const errorBytes = Buffer.from(expectedError);
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        for (
          let index = 0;
          index < Math.max(bytes.length, errorBytes.length);
          index += 1
        ) {
          const stdoutByte = bytes[index];
          const stderrByte = errorBytes[index];
          if (stdoutByte !== undefined)
            child.stdout.emit("data", Buffer.from([stdoutByte]));
          if (stderrByte !== undefined)
            child.stderr.emit("data", Buffer.from([stderrByte]));
        }
        child.emit("close", 0);
      });
      return child;
    });
    const result = await new CommandRunner().run({
      cwd: "/worktree",
      command: "split-utf8",
      captureOutput: true,
      capturePolicy: "complete",
      suppressOutput: true,
    });
    expect(result.output).toBe(expected);
    expect(result.errorOutput).toBe(expectedError);
  });

  it("replaces an incomplete terminal UTF-8 sequence when flushing the stream", async () => {
    const child = createFakeChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from([0x61, 0xf0, 0x9f]));
        child.emit("close", 0);
      });
      return child;
    });
    const result = await new CommandRunner().run({
      cwd: "/worktree",
      command: "incomplete-utf8",
      captureOutput: true,
      capturePolicy: "complete",
      suppressOutput: true,
    });
    // Node's StringDecoder policy: malformed/incomplete UTF-8 becomes U+FFFD.
    expect(result.output).toBe("a�");
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
      processFamily: "github",
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
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it("writes separately redacted stdout and stderr plus terminal execution evidence", async () => {
    const child = createFakeChild();
    const artifactDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "process-artifacts-"),
    );
    temporaryDirectories.push(artifactDirectory);
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("out secret-value\n"));
        child.stderr.emit("data", Buffer.from("err secret-value\n"));
        child.emit("close", 7);
      });
      return child;
    });

    await expect(
      new CommandRunner().run({
        cwd: "/worktree",
        command: "test-command",
        secretValues: ["secret-value"],
        artifactDirectory,
      }),
    ).resolves.toMatchObject({ exitCode: 7 });

    const [executionId] = fs.readdirSync(artifactDirectory);
    expect(executionId).toBeDefined();
    const directory = path.join(artifactDirectory, executionId!);
    expect(fs.readFileSync(path.join(directory, "stdout.txt"), "utf8")).toBe(
      "out [REDACTED]\n",
    );
    expect(fs.readFileSync(path.join(directory, "stderr.txt"), "utf8")).toBe(
      "err [REDACTED]\n",
    );
    expect(
      fs.readFileSync(path.join(directory, "execution.json"), "utf8"),
    ).toContain('"status": "nonzero"');
  });

  it("rejects an artifact budget overflow even when output capture is disabled", async () => {
    const child = createFakeChild();
    const artifactDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "process-evidence-budget-"),
    );
    temporaryDirectories.push(artifactDirectory);
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit(
          "data",
          Buffer.alloc(PROCESS_EVIDENCE_MAX_BYTES + 1, 120),
        );
        child.emit("close", 0);
      });
      return child;
    });

    await expect(
      new CommandRunner().run({
        cwd: "/worktree",
        command: "noisy-command",
        captureOutput: false,
        artifactDirectory,
      }),
    ).rejects.toThrow("Process evidence exceeded");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    const [executionId] = fs.readdirSync(artifactDirectory);
    expect(executionId).toBeDefined();
    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(artifactDirectory, executionId!, "execution.json"),
        "utf8",
      ),
    ) as { status: string; exitCode: number };
    expect(metadata).toMatchObject({ status: "evidence-failure", exitCode: 0 });
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
    child.emit("close", null);
    await rejection;

    vi.useRealTimers();
  });

  it("retains buffered session output when a command is force-terminated", async () => {
    vi.useFakeTimers();

    const child = createFakeChild();
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-orchestrator-command-timeout-"),
    );
    temporaryDirectories.push(temporaryDirectory);
    const sessionLogPath = path.join(temporaryDirectory, "card.log");
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("timeout test output\n"));
      });
      return child;
    });

    const request = new CommandRunner().run({
      cwd: "/worktree",
      command: "yarn validate",
      timeoutMilliseconds: 1_000,
      sessionLogPath,
    });
    const rejection =
      expect(request).rejects.toBeInstanceOf(CommandTimeoutError);

    await vi.advanceTimersByTimeAsync(6_000);

    child.emit("close", null);
    await rejection;
    expect(fs.readFileSync(sessionLogPath, "utf8")).toContain(
      "timeout test output\n",
    );

    vi.useRealTimers();
  });

  it("terminates and settles when a child-output session-log append fails", async () => {
    const child = createFakeChild();
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "injected-session-log-failure-"),
    );
    temporaryDirectories.push(directory);
    const logDirectory = path.join(directory, "session");
    const logPath = path.join(logDirectory, "output.log");
    spawnMock.mockImplementationOnce(() => {
      return child;
    });

    const request = new CommandRunner().run({
      cwd: "/worktree",
      command: "test-command",
      sessionLogPath: logPath,
    });
    const rejection = expect(request).rejects.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    fs.rmSync(logDirectory, { recursive: true });
    fs.writeFileSync(logDirectory, "not a directory");
    child.stdout.emit("data", Buffer.from("output\n"));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null);
    await rejection;
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
