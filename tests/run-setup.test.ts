import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getProcessRuntime } from "../src/process/process-runtime.js";
import { GitClient } from "../src/git/git-client.js";

import { WorkflowError } from "../src/orchestrator/workflow-error.js";
import {
  CommandRunAbortedError,
  CommandRunner,
  type RunCommand,
} from "../src/process/command-runner.js";
import {
  captureSetupEffects,
  runRepositorySetup,
} from "../src/process/run-setup.js";

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

  it("records tracked, untracked, and ignored file identities outside the worktree", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-effects-"));
    const worktree = path.join(root, "worktree");
    fs.mkdirSync(worktree);
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: worktree, stdio: "ignore" });
    try {
      git(["init", "-q"]);
      git(["config", "user.email", "test@example.invalid"]);
      git(["config", "user.name", "Setup test"]);
      fs.writeFileSync(path.join(worktree, ".gitignore"), "ignored.out\n");
      fs.writeFileSync(path.join(worktree, "tracked.txt"), "initial");
      git(["add", "."]);
      git(["commit", "-qm", "fixture"]);
      const before = await captureSetupEffects(new GitClient(), worktree);
      fs.writeFileSync(path.join(worktree, "tracked.txt"), "setup changed");
      fs.writeFileSync(path.join(worktree, "lockfile"), "generated");
      fs.writeFileSync(path.join(worktree, "ignored.out"), "ignored generated");
      const after = await captureSetupEffects(new GitClient(), worktree);
      const beforeFiles = JSON.parse(before.toString()).files as {
        path: string;
      }[];
      const afterFiles = JSON.parse(after.toString()).files as {
        path: string;
      }[];
      expect(beforeFiles.map((file) => file.path)).toContain("tracked.txt");
      expect(afterFiles.map((file) => file.path)).toEqual(
        expect.arrayContaining(["tracked.txt", "lockfile", "ignored.out"]),
      );
      expect(after).not.toEqual(before);
      expect(fs.readdirSync(root)).toEqual(["worktree"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("captures actual command failure and timeout while retaining separate process evidence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-command-"));
    try {
      const runner = new CommandRunner();
      await expect(
        runRepositorySetup(runner, {
          cwd: root,
          command: "printf successful > success.txt",
          timeoutMilliseconds: 5_000,
          sessionLogPath: path.join(root, "success.log"),
          sessionLabel: "setup success test",
        }),
      ).resolves.toMatchObject({
        exitCode: 0,
        executionId: expect.any(String),
      });
      expect(fs.readFileSync(path.join(root, "success.txt"), "utf8")).toBe(
        "successful",
      );
      await expect(
        runRepositorySetup(runner, {
          cwd: root,
          command: "printf before-failure > failure.txt; exit 7",
          timeoutMilliseconds: 5_000,
          sessionLogPath: path.join(root, "setup.log"),
          sessionLabel: "setup test",
        }),
      ).resolves.toMatchObject({ exitCode: 7 });
      expect(fs.readFileSync(path.join(root, "failure.txt"), "utf8")).toBe(
        "before-failure",
      );
      let timedOutExecutionId: string | undefined;
      await expect(
        runRepositorySetup(runner, {
          cwd: root,
          command: "printf before-timeout > timeout.txt; sleep 10",
          timeoutMilliseconds: 50,
          sessionLogPath: path.join(root, "timeout.log"),
          sessionLabel: "setup timeout test",
          onExecutionStarted: (id) => {
            timedOutExecutionId = id;
          },
        }),
      ).rejects.toThrow(/timeout/i);
      expect(fs.readFileSync(path.join(root, "timeout.txt"), "utf8")).toBe(
        "before-timeout",
      );
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(
              getProcessRuntime().artifactRoot,
              "process-executions",
              timedOutExecutionId!,
              "execution.json",
            ),
            "utf8",
          ),
        ),
      ).toMatchObject({ status: "timeout", treeStopped: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds the durable process identity before dispatch and exposes its finished result", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-binding-"));
    try {
      let executionId: string | undefined;
      const result = await runRepositorySetup(new CommandRunner(), {
        cwd: root,
        command: `test -f '${path.join(root, "bound")}' && printf finished > '${path.join(root, "result")}'`,
        timeoutMilliseconds: 5_000,
        sessionLogPath: path.join(root, "setup.log"),
        sessionLabel: "bound setup",
        onExecutionStarted: (id) => {
          executionId = id;
          fs.writeFileSync(path.join(root, "bound"), id);
        },
      });
      expect(result.executionId).toBe(executionId);
      expect(fs.readFileSync(path.join(root, "result"), "utf8")).toBe(
        "finished",
      );
      const metadata = JSON.parse(
        fs.readFileSync(
          path.join(
            getProcessRuntime().artifactRoot,
            "process-executions",
            executionId!,
            "execution.json",
          ),
          "utf8",
        ),
      ) as { status: string; exitCode: number; treeStopped: boolean };
      expect(metadata).toMatchObject({
        status: "success",
        exitCode: 0,
        treeStopped: true,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("supervises and drains a spawned descendant when PID metadata persistence fails", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "setup-pid-write-failure-"),
    );
    const artifacts = path.join(root, "artifacts");
    fs.mkdirSync(artifacts);
    const pidFile = path.join(root, "descendant.pid");
    const originalWriteFileSync = fs.writeFileSync;
    let failedDispatchWrite = false;
    const writeSpy = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementation((file, data, options) => {
        if (
          !failedDispatchWrite &&
          String(file).endsWith("execution.json") &&
          typeof data === "string" &&
          data.includes('"dispatchState": "dispatched"')
        ) {
          const deadline = Date.now() + 2_000;
          while (!fs.existsSync(pidFile) && Date.now() < deadline)
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          failedDispatchWrite = true;
          throw new Error("injected dispatch metadata failure");
        }
        return originalWriteFileSync(file, data, options);
      });
    let executionId: string | undefined;
    try {
      await expect(
        new CommandRunner().run({
          cwd: root,
          command: `sleep 20 & child=$!; printf '%s' "$child" > '${pidFile}'; wait "$child"`,
          timeoutMilliseconds: 10_000,
          artifactDirectory: artifacts,
          onExecutionStarted: (id) => {
            executionId = id;
          },
        }),
      ).rejects.toThrow(/injected dispatch metadata failure/u);
      expect(failedDispatchWrite).toBe(true);
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      expect(Number.isSafeInteger(pid)).toBe(true);
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (error) {
        alive = !(
          error instanceof Error &&
          "code" in error &&
          error.code === "ESRCH"
        );
      }
      expect(alive).toBe(false);
      const metadata = JSON.parse(
        fs.readFileSync(
          path.join(artifacts, executionId!, "execution.json"),
          "utf8",
        ),
      ) as { treeStopped: boolean; status: string };
      expect(metadata).toMatchObject({
        treeStopped: false,
        status: "evidence-failure",
      });
    } finally {
      writeSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
