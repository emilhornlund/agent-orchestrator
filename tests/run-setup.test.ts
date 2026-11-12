import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { configureProcessRuntime, getProcessRuntime } from "../src/process/process-runtime.js";
import { GitClient } from "../src/git/git-client.js";

import { WorkflowError } from "../src/orchestrator/workflow-error.js";
import {
  CommandRunAbortedError,
  CommandRunner,
  type RunCommand,
} from "../src/process/command-runner.js";
import { captureSetupEffects, runRepositorySetup } from "../src/process/run-setup.js";
import {
  getSetupTrackedDelta,
  resolveSetupCommitScope,
  setupFileIdentity,
} from "../src/process/setup-commit-scope.js";

interface LinuxProcessIdentity {
  state: string;
  startTime: string;
}

function readLinuxProcessIdentity(pid: number): LinuxProcessIdentity | undefined {
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  const closeParen = stat.lastIndexOf(")");
  if (closeParen < 0) throw new Error(`Malformed /proc/${pid}/stat`);
  const fields = stat.slice(closeParen + 2).split(" ");
  const state = fields[0];
  const startTime = fields[19];
  if (!state || !startTime) throw new Error(`Malformed /proc/${pid}/stat`);
  return { state, startTime };
}

describe("runRepositorySetup", () => {
  it("finishes the bounded setup inventory after runtime cancellation but stops baseline reads", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-aborted-inventory-"));
    const worktree = path.join(root, "repo");
    fs.mkdirSync(worktree);
    const git = (args: string[]) => execFileSync("git", args, { cwd: worktree, stdio: "ignore" });
    const controller = new AbortController();
    try {
      git(["init", "-q"]);
      git(["config", "user.email", "test@example.invalid"]);
      git(["config", "user.name", "Setup inventory test"]);
      fs.writeFileSync(path.join(worktree, "tracked.txt"), "before\n");
      git(["add", "."]);
      git(["commit", "-qm", "baseline"]);
      fs.writeFileSync(path.join(worktree, "tracked.txt"), "after\n");
      controller.abort();
      configureProcessRuntime({ runtimeRoot: root, signal: controller.signal });
      const client = new GitClient();

      await expect(captureSetupEffects(client, worktree, controller.signal)).rejects.toThrow(
        /abort/i,
      );
      const effects = JSON.parse(
        (await captureSetupEffects(client, worktree, controller.signal, true)).toString("utf8"),
      ) as { status: string; committable: string[] };
      expect(effects.status).toContain("tracked.txt");
      expect(effects.committable).toContain("tracked.txt");
    } finally {
      configureProcessRuntime({
        runtimeRoot: os.tmpdir(),
        signal: new AbortController().signal,
      });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts only a complete current-content-bound setup relevance verdict", () => {
    const before = {
      files: [
        {
          path: "package.json",
          kind: "file",
          mode: 0o644,
          sha256: "a",
          bytes: 1,
        },
      ],
      tracked: ["package.json"],
      committable: ["package.json"],
      untracked: [],
    };
    const after = {
      files: [
        {
          path: "package.json",
          kind: "file",
          mode: 0o644,
          sha256: "b",
          bytes: 1,
        },
        { path: "yarn.lock", kind: "file", mode: 0o644, sha256: "c", bytes: 1 },
      ],
      tracked: ["package.json"],
      committable: ["package.json", "yarn.lock"],
      untracked: ["yarn.lock"],
    };
    const delta = getSetupTrackedDelta(before, after, after);
    const verdict = {
      version: 1,
      contextDigest: delta.contextDigest,
      changes: [
        {
          path: "package.json",
          identity: setupFileIdentity(after.files[0]!),
          relevant: true,
        },
        {
          path: "yarn.lock",
          identity: setupFileIdentity(after.files[1]!),
          relevant: false,
        },
      ],
    };
    expect(resolveSetupCommitScope(before, after, after, verdict)).toMatchObject({
      include: ["package.json"],
      exclude: [{ path: "yarn.lock" }],
    });
    expect(() =>
      resolveSetupCommitScope(before, after, after, {
        version: 1,
        contextDigest: delta.contextDigest,
        changes: [],
      }),
    ).toThrow(/cover/u);
    expect(() => resolveSetupCommitScope(before, after, after, null)).toThrow(/malformed/u);
    expect(() =>
      resolveSetupCommitScope(
        before,
        after,
        {
          ...after,
          files: [after.files[0]!],
          untracked: [],
        },
        verdict,
      ),
    ).toThrow(/context-stale/u);
    expect(() =>
      resolveSetupCommitScope(before, after, after, {
        ...verdict,
        changes: verdict.changes.map((change) => ({
          ...change,
          identity: "sha256:stale",
        })),
      }),
    ).toThrow(/stale/u);
    const differentBefore = {
      ...before,
      files: [{ ...before.files[0]!, sha256: "different-before" }],
    };
    expect(() => resolveSetupCommitScope(differentBefore, after, after, verdict)).toThrow(
      /context-stale/u,
    );
  });

  it("judges mode-only tracked changes while excluding ignored dependencies from setup scope", () => {
    const before = {
      files: [
        { path: "run.sh", kind: "file", mode: 0o644, sha256: "same", bytes: 1 },
        {
          path: "node_modules/pkg/data",
          kind: "file",
          mode: 0o644,
          sha256: "old",
          bytes: 1,
        },
      ],
      tracked: ["run.sh"],
      committable: ["run.sh"],
      untracked: [],
    };
    const after = {
      files: [
        { path: "run.sh", kind: "file", mode: 0o755, sha256: "same", bytes: 1 },
        {
          path: "node_modules/pkg/data",
          kind: "file",
          mode: 0o644,
          sha256: "new",
          bytes: 1,
        },
      ],
      tracked: ["run.sh"],
      committable: ["run.sh"],
      untracked: [],
    };
    const delta = getSetupTrackedDelta(before, after, after);
    expect(delta.candidates.map((file) => file.path)).toEqual(["run.sh"]);
    const scope = resolveSetupCommitScope(before, after, after, {
      version: 1,
      contextDigest: delta.contextDigest,
      changes: [
        {
          path: "run.sh",
          identity: setupFileIdentity(after.files[0]!),
          relevant: false,
        },
      ],
    });
    expect(scope.exclude).toMatchObject([{ path: "run.sh" }]);
  });

  it("keeps excluded setup output in the worktree while staging other task changes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-scope-git-"));
    const worktree = path.join(root, "repo");
    fs.mkdirSync(worktree);
    const git = (args: string[]) => execFileSync("git", args, { cwd: worktree, stdio: "ignore" });
    try {
      git(["init", "-q"]);
      git(["config", "user.email", "test@example.invalid"]);
      git(["config", "user.name", "Setup scope test"]);
      fs.writeFileSync(path.join(worktree, ".gitignore"), "node_modules/\n");
      fs.writeFileSync(path.join(worktree, "task.txt"), "base");
      fs.writeFileSync(path.join(worktree, "unrelated.txt"), "base");
      git(["add", "."]);
      git(["commit", "-qm", "base"]);
      fs.writeFileSync(path.join(worktree, "task.txt"), "task change");
      fs.writeFileSync(path.join(worktree, "unrelated.txt"), "setup change");
      fs.chmodSync(path.join(worktree, "unrelated.txt"), 0o755);
      fs.mkdirSync(path.join(worktree, "node_modules", "dependency"), {
        recursive: true,
      });
      fs.writeFileSync(path.join(worktree, "node_modules", "dependency", "generated"), "ignored");
      await new GitClient().stageAllExcept(worktree, ["unrelated.txt"]);
      const output = (args: string[]) => execFileSync("git", args, { cwd: worktree });
      const staged = output(["diff", "--cached", "--name-only"]).toString();
      expect(staged).toBe("task.txt\n");
      expect(fs.readFileSync(path.join(worktree, "unrelated.txt"), "utf8")).toBe("setup change");
      expect(output(["status", "--porcelain"]).toString()).toContain(" M unrelated.txt");
      expect(output(["status", "--porcelain", "--ignored"]).toString()).toContain(
        "!! node_modules/",
      );
      output([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "task",
      ]);
      expect(output(["show", "HEAD:unrelated.txt"]).toString()).toBe("base");
      expect(output(["ls-tree", "HEAD", "unrelated.txt"]).toString()).toContain("100644");
      expect(fs.readFileSync(path.join(worktree, "unrelated.txt"), "utf8")).toBe("setup change");
      expect((fs.statSync(path.join(worktree, "unrelated.txt")).mode & 0o111) !== 0).toBe(true);
      expect(
        fs.readFileSync(path.join(worktree, "node_modules", "dependency", "generated"), "utf8"),
      ).toBe("ignored");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
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
    const runCommand = vi.fn<RunCommand>().mockRejectedValue(new CommandRunAbortedError());

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
    const git = (args: string[]) => execFileSync("git", args, { cwd: worktree, stdio: "ignore" });
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
      expect(fs.readFileSync(path.join(root, "success.txt"), "utf8")).toBe("successful");
      await expect(
        runRepositorySetup(runner, {
          cwd: root,
          command: "printf before-failure > failure.txt; exit 7",
          timeoutMilliseconds: 5_000,
          sessionLogPath: path.join(root, "setup.log"),
          sessionLabel: "setup test",
        }),
      ).resolves.toMatchObject({ exitCode: 7 });
      expect(fs.readFileSync(path.join(root, "failure.txt"), "utf8")).toBe("before-failure");
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
      expect(fs.readFileSync(path.join(root, "timeout.txt"), "utf8")).toBe("before-timeout");
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
      expect(fs.readFileSync(path.join(root, "result"), "utf8")).toBe("finished");
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-pid-write-failure-"));
    const artifacts = path.join(root, "artifacts");
    fs.mkdirSync(artifacts);
    const pidFile = path.join(root, "descendant.pid");
    const originalWriteFileSync = fs.writeFileSync;
    let failedDispatchWrite = false;
    let descendantIdentity: LinuxProcessIdentity | undefined;
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (
        !failedDispatchWrite &&
        String(file).endsWith("execution.json") &&
        typeof data === "string" &&
        data.includes('"dispatchState": "dispatched"')
      ) {
        const deadline = Date.now() + 2_000;
        while (!fs.existsSync(pidFile) && Date.now() < deadline)
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        if (fs.existsSync(pidFile)) {
          descendantIdentity = readLinuxProcessIdentity(Number(fs.readFileSync(pidFile, "utf8")));
        }
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
      expect(descendantIdentity).toBeDefined();
      const originalStartTime = descendantIdentity!.startTime;
      const deadline = Date.now() + 2_000;
      let originalProcessState = readLinuxProcessIdentity(pid);
      while (
        originalProcessState?.startTime === originalStartTime &&
        originalProcessState.state !== "Z" &&
        originalProcessState.state !== "X" &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        originalProcessState = readLinuxProcessIdentity(pid);
      }
      // kill(pid, 0) also succeeds for an orphaned zombie. Match the captured
      // kernel start time so a reused PID cannot masquerade as this child.
      expect(
        originalProcessState?.startTime !== originalStartTime ||
          originalProcessState.state === "Z" ||
          originalProcessState.state === "X",
      ).toBe(true);
      const metadata = JSON.parse(
        fs.readFileSync(path.join(artifacts, executionId!, "execution.json"), "utf8"),
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
