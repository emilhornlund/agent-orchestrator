import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

type ChildExit = [number | null, NodeJS.Signals | null];
type ManagedChild = { child: ChildProcess; exited: Promise<ChildExit> };

async function waitForChildExit(
  managed: ManagedChild,
  timeoutMs: number,
): Promise<boolean> {
  return Promise.race([
    managed.exited.then(() => true),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), timeoutMs),
    ),
  ]);
}

async function stopChildren(children: Set<ManagedChild>): Promise<void> {
  for (const managed of children) {
    const { child } = managed;
    if (child.exitCode !== null || child.signalCode !== null) {
      await managed.exited;
      continue;
    }
    child.kill("SIGTERM");
    if (!(await waitForChildExit(managed, 2_000))) {
      child.kill("SIGKILL");
      if (!(await waitForChildExit(managed, 5_000)))
        throw new Error(
          `Failed to reap child process ${child.pid} after SIGKILL`,
        );
    }
    await managed.exited;
  }
  children.clear();
}

describe("P5 graceful shutdown continuation", () => {
  it("adopts a completed owned operation after SIGTERM without redispatch", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "p5-shutdown-resume-"));
    const children = new Set<ManagedChild>();
    try {
      const repository = path.join(root, "repository");
      fs.mkdirSync(repository);
      execFileSync("git", ["init", "--initial-branch=main", repository]);
      execFileSync("git", ["-C", repository, "config", "user.name", "Fixture"]);
      execFileSync("git", [
        "-C",
        repository,
        "config",
        "user.email",
        "fixture@example.test",
      ]);
      fs.writeFileSync(path.join(repository, "source.txt"), "base\n");
      execFileSync("git", ["-C", repository, "add", "."]);
      execFileSync("git", ["-C", repository, "commit", "-m", "base"]);
      fs.writeFileSync(
        path.join(repository, "source.txt"),
        "dirty implementation bytes\n",
      );
      const sourceBytes = fs.readFileSync(path.join(repository, "source.txt"));
      fs.mkdirSync(path.join(root, "coordination"));
      const childScript = `
        import fs from "node:fs";
        import path from "node:path";
        import { acquireProjectOwnership, provisionCoordinationNamespace } from ${JSON.stringify(path.resolve("src/coordination/project-ownership.ts"))};
        import { TaskExecutionStore } from ${JSON.stringify(path.resolve("src/task-session/task-execution-store.ts"))};
        import { runPrimaryOperation } from ${JSON.stringify(path.resolve("src/task-session/run-primary-operation.ts"))};
        const root = process.argv[1];
        const mode = process.argv[2];
        const state = path.join(root, "state");
        const project = { id: "project", repository: { path: path.join(root, "repository"), worktreeRoot: path.join(root, "worktrees"), defaultBranch: "main" } };
        const coordination = path.join(root, "coordination");
        if (mode === "first") provisionCoordinationNamespace(coordination, "p5-resume");
        const owner = await acquireProjectOwnership(coordination, { trelloBoardId: "board", githubRepository: "owner/repo" }, "p5-resume");
        const store = new TaskExecutionStore(state, project);
        if (mode === "first") store.create({ version: 1, projectId: "project", cardId: "card", phase: "implementation", operationKey: "same-operation", expectedBranch: "agent/card", revision: 1, retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 }, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", primarySessionId: "session-lineage" });
        const execute = async () => {
          fs.appendFileSync(path.join(root, "dispatches"), "dispatch\\n");
          if (mode === "restart") throw new Error("completed operation must not execute again");
          const result = { exitCode: 0, output: "operation-result", errorOutput: "", sessionId: "session-lineage" };
          fs.writeFileSync(path.join(root, "completed-result.json"), JSON.stringify({ result, pid: process.pid, operationId: "same-operation", sessionId: "session-lineage" }));
          fs.writeFileSync(path.join(root, "result-ready"), "ready");
          await new Promise((_, reject) => {
            const keepAlive = setInterval(() => {}, 60_000);
            process.once("SIGTERM", () => {
              clearInterval(keepAlive);
              reject(new Error("graceful shutdown"));
            });
          });
          return result;
        };
        try {
          const result = await runPrimaryOperation({
            store, cardId: "card", operationId: "same-operation", activity: "implementation", sessionId: "session-lineage", execute,
            inspectPending: async () => {
              const evidence = JSON.parse(fs.readFileSync(path.join(root, "completed-result.json"), "utf8"));
              try { process.kill(evidence.pid, 0); return { status: "running" }; } catch (error) { if (error.code !== "ESRCH") throw error; }
              if (evidence.operationId !== "same-operation" || evidence.sessionId !== "session-lineage") return { status: "unknown" };
              return { status: "completed", result: evidence.result };
            },
          });
          fs.writeFileSync(path.join(root, "restarted.json"), JSON.stringify({ result, entry: store.read("card").primaryOperations["same-operation"], primarySessionId: store.read("card").primarySessionId }));
        } catch (error) {
          if (mode !== "first" || !(error instanceof Error) || error.name !== "PrimaryOperationWaitingError") throw error;
          fs.writeFileSync(path.join(root, "shutdown-complete"), "ledger retained for reconciliation");
        } finally { await owner.release(); }
      `;
      const launch = (mode: string): ManagedChild => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            childScript,
            root,
            mode,
          ],
          {
            cwd: process.cwd(),
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              TMPDIR: process.env.TMPDIR,
              VITEST: "false",
            },
            stdio: "inherit",
          },
        );
        const exited = new Promise<ChildExit>((resolve, reject) => {
          child.once("exit", (code, signal) => resolve([code, signal]));
          child.once("error", reject);
        });
        const managed = { child, exited };
        children.add(managed);
        void exited.then(
          () => children.delete(managed),
          () => children.delete(managed),
        );
        void exited.catch(() => {});
        return managed;
      };
      const first = launch("first");
      const deadline = Date.now() + 15_000;
      while (
        !fs.existsSync(path.join(root, "result-ready")) &&
        Date.now() < deadline &&
        first.child.exitCode === null &&
        first.child.signalCode === null
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fs.existsSync(path.join(root, "result-ready"))).toBe(true);
      first.child.kill("SIGTERM");
      const [firstCode, firstSignal] = await first.exited;
      expect(firstSignal).toBeNull();
      expect(firstCode).toBe(0);
      expect(
        fs.readFileSync(path.join(root, "shutdown-complete"), "utf8"),
      ).toContain("retained");
      const restart = launch("restart");
      const [restartCode, restartSignal] = await restart.exited;
      expect(restartSignal).toBeNull();
      expect(restartCode).toBe(0);
      const completed = JSON.parse(
        fs.readFileSync(path.join(root, "restarted.json"), "utf8"),
      ) as {
        result: { output: string };
        primarySessionId: string;
        entry: {
          id: string;
          executions: number;
          status: string;
          lastSessionId: string;
        };
      };
      expect(completed.result.output).toBe("operation-result");
      expect(completed).toMatchObject({
        primarySessionId: "session-lineage",
        entry: {
          id: "same-operation",
          executions: 1,
          status: "completed",
          lastSessionId: "session-lineage",
        },
      });
      expect(fs.readFileSync(path.join(root, "dispatches"), "utf8")).toBe(
        "dispatch\n",
      );
      expect(fs.readFileSync(path.join(repository, "source.txt"))).toEqual(
        sourceBytes,
      );
      expect(
        execFileSync("git", ["-C", repository, "status", "--porcelain"], {
          encoding: "utf8",
        }),
      ).toContain("M source.txt");
    } finally {
      await stopChildren(children);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});
