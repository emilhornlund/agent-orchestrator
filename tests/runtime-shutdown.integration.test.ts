import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { acquireProjectOwnership } from "../src/coordination/project-ownership.js";

const execFile = promisify(nodeExecFile);

function readProcessStat(
  pid: number,
): { state: string; processGroupId: number } | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingParenthesis = stat.lastIndexOf(")");
    if (closingParenthesis < 0) throw new Error("Malformed /proc stat record");
    const fields = stat
      .slice(closingParenthesis + 2)
      .trim()
      .split(/\s+/u);
    const state = fields[0];
    const processGroupId = Number(fields[2]);
    if (!/^[A-Z]$/u.test(state ?? "") || !Number.isSafeInteger(processGroupId))
      throw new Error("Malformed /proc stat fields");
    return { state: state!, processGroupId };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function hasLiveProcessGroupMember(processGroupId: number): boolean {
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    const processStat = readProcessStat(Number(entry));
    if (
      processStat?.processGroupId === processGroupId &&
      processStat.state !== "Z" &&
      processStat.state !== "X"
    )
      return true;
  }
  return false;
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

describe("P3 coordinated shutdown integration", () => {
  it("drains an owned command before startup releases its lease and preserves its pinned attempt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "p3-shutdown-"));
    try {
      const script = `
        import fs from "node:fs";
        import path from "node:path";
        import { CommandRunner } from ${JSON.stringify(path.resolve("src/process/command-runner.ts"))};
        import { runStartup } from ${JSON.stringify(path.resolve("src/startup/run-startup.ts"))};
        import { RuntimeLifecycle, installProcessHandlers } from ${JSON.stringify(path.resolve("src/runtime/runtime-lifecycle.ts"))};
        import { ProjectRunAuthority } from ${JSON.stringify(path.resolve("src/task-session/project-run-authority.ts"))};
        import { runOrchestrator } from ${JSON.stringify(path.resolve("src/orchestrator/run-orchestrator.ts"))};
        import { GitClient } from ${JSON.stringify(path.resolve("src/git/git-client.ts"))};
        import { provisionCoordinationNamespace } from ${JSON.stringify(path.resolve("src/coordination/project-ownership.ts"))};
        const [root, phase] = process.argv.slice(1);
        fs.writeFileSync(path.join(root, phase + ".boot"), JSON.stringify({ argv: process.argv }));
        const source = path.join(root, "actual-worktree");
        const coordinationRoot = path.join(root, "coordination");
        if (phase === "first") provisionCoordinationNamespace(coordinationRoot, "p3-shutdown");
        const project = {
          id: "shutdown-project", autoMerge: false,
          repository: { path: source, github: "owner/shutdown", defaultBranch: "main", worktreeRoot: path.join(root, "worktrees"), gitIdentity: { name: "Fixture", email: "fixture@example.test" } },
          trello: { boardId: "board", backlogListId: "backlog", readyListId: "ready", workingListId: "working", reviewListId: "review", failedListId: "failed", doneListId: "done", refinementLabelId: "refinement", featureLabelId: "feature", improvementLabelId: "improvement", bugLabelId: "bug" },
          opencode: { refinement: { model: "r", variant: "v" }, implementation: { model: "i", variant: "v" }, review: { model: "r", variant: "v" }, remediation: { model: "r", variant: "v", maxPasses: 1 }, commit: { model: "c", variant: "v" }, timeoutMinutes: 1 }
        };
        const config = { projects: [project], workflow: { pollIntervalSeconds: 1, logRetentionDays: 30, contextRetentionDays: 30, contextRoot: path.join(root, "context"), coordinationRoot, coordinationNamespaceId: "p3-shutdown" } };
        const lifecycle = new RuntimeLifecycle({ logger: { event() {}, error() {} } });
        const removeHandlers = installProcessHandlers(lifecycle);
        let claimCount = 0;
        let lateClaimCount = 0;
        let readyReadCount = 0;
        let retainedAuthority;
        const deps = {
          trello: {
            getCards: async (listId) => {
              if (phase === "first" && listId === project.trello.readyListId)
                { readyReadCount++; return [{ id: "first-card", name: "First task", desc: "fixture", idList: listId, idLabels: ["feature"], url: "https://trello.test/first-card" }]; }
              return [];
            },
            moveCard: async (_id, _listId) => {
              claimCount++;
              if (lifecycle.signal.aborted) lateClaimCount++;
              return {};
            },
          },
          git: new GitClient(async (_cwd, args) => args[0] === "remote" ? "https://github.com/owner/shutdown.git" : "true"),
          github: {}, opencode: {}, commands: new CommandRunner(undefined, lifecycle.signal)
        };
        let runCount = 0;
        let dispatchCount = 0;
        let terminal = false;
        const ops = {
          // Offline StartupOperations adapters are limited to startup probes.
          // The first-run wrapper creates the persisted attempt under startup's
          // real project lease, starts CommandRunner under that authority, then
          // invokes the production worker with runStartup's actual contexts.
          // This test covers shutdown preservation only, not P5 task resumption.
          validateToolchain: async () => {}, validateGitHubCli: async () => {},
          validateProjectGitHub: async () => {}, validateProjectTrello: async () => {},
          runOrchestrator: async (_t, _g, _gh, _o, commands, _config, signal, _email, _deferred, contexts) => {
            runCount++;
            fs.writeFileSync(path.join(root, phase + ".worker"), "entered");
            if (phase === "restart") {
              const context = contexts.get(project.id);
              if (!context?.authority) throw new Error("pinned attempt was not resumed");
              const record = context.authority.store.read();
              let secondClaimBlocked = false;
              try {
                await ProjectRunAuthority.createPreparingAttempt({ projectId: project.id, cardId: "second-card", taskKind: "implementation", pinned: context.pinned, projectLease: context.projectLease, coordinationRoot, attemptId: "must-not-create-second-attempt" });
              } catch (error) {
                if (!(error instanceof Error) || !error.message.includes("A project attempt is still occupying the canonical registry")) throw error;
                secondClaimBlocked = true;
              }
              fs.writeFileSync(path.join(root, "restart.json"), JSON.stringify({ attemptId: record.attemptId, pinned: record.pinned, sessions: record.sessions, secondClaimBlocked }));
              return;
            }
            const context = contexts.get(project.id);
            if (!context?.projectLease || !context.pinned) throw new Error("startup did not provide leased project context");
            const authority = await ProjectRunAuthority.createPreparingAttempt({ projectId: project.id, cardId: "first-card", taskKind: "implementation", pinned: context.pinned, projectLease: context.projectLease, coordinationRoot, attemptId: "p3-shutdown-attempt", sessions: { primary: "fixture-session" } });
            retainedAuthority = authority;
            contexts.set(project.id, { ...context, authority });
            fs.writeFileSync(path.join(root, phase + ".authority"), "created");
            dispatchCount++;
            await authority.run(async () => {
              fs.writeFileSync(path.join(root, phase + ".dispatch"), "entered");
              const childDrain = commands.run({ command: JSON.stringify(process.execPath) + " " + JSON.stringify(${JSON.stringify(path.resolve("tests/fixtures/shutdown-owned-child.mjs"))}) + " " + JSON.stringify(path.join(root, "child.pid")), cwd: source });
              await runOrchestrator(_t, _g, _gh, _o, commands, _config, signal, undefined, undefined, contexts);
              await childDrain.catch((error) => { if (!signal.aborted) throw error; });
            });
            terminal = true;
            fs.writeFileSync(path.join(root, "drained.json"), JSON.stringify({ aborted: signal.aborted, dispatchCount }));
          }
        };
        try {
          try { await runStartup(config, deps, lifecycle.signal, ops); }
          catch (error) { fs.writeFileSync(path.join(root, phase + ".error"), error instanceof Error ? error.stack ?? error.message : String(error)); throw error; }
          let releasedLeaseRejectsWrites = false;
          if (retainedAuthority) {
            try {
              retainedAuthority.mutate("shutdown-write-guard", null, () => ({ value: { attempted: true }, result: true }), (value) => value);
            } catch (error) {
              if (!(error instanceof Error) || !/lease|owner|held/iu.test(error.message)) throw error;
              releasedLeaseRejectsWrites = true;
            }
          }
          fs.writeFileSync(path.join(root, phase + ".done"), JSON.stringify({ runCount, dispatchCount, terminal, aborted: lifecycle.signal.aborted, claimCount, lateClaimCount, readyReadCount, releasedLeaseRejectsWrites }));
        } finally { removeHandlers(); }
      `;
      const repository = path.join(root, "repository");
      const source = path.join(root, "actual-worktree");
      fs.mkdirSync(repository, { recursive: true });
      fs.mkdirSync(path.join(root, "coordination"), { recursive: true });
      const git = (
        await execFile("git", ["init", "--initial-branch=main", repository])
      ).stdout;
      void git;
      await execFile("git", [
        "-C",
        repository,
        "config",
        "user.name",
        "Fixture",
      ]);
      await execFile("git", [
        "-C",
        repository,
        "config",
        "user.email",
        "fixture@example.test",
      ]);
      fs.writeFileSync(path.join(repository, "tracked.txt"), "fixture\n");
      await execFile("git", ["-C", repository, "add", "."]);
      await execFile("git", ["-C", repository, "commit", "-m", "fixture"]);
      await execFile("git", [
        "-C",
        repository,
        "worktree",
        "add",
        "-b",
        "agent/p3-shutdown",
        source,
        "main",
      ]);
      fs.writeFileSync(
        path.join(source, "tracked.txt"),
        "uncommitted implementation in progress\n",
      );
      const launch = (phase: string) => {
        const child = nodeExecFile(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", script, root, phase],
          { cwd: process.cwd(), env: { ...process.env, VITEST: "false" } },
        );
        const watchdog = setTimeout(() => child.kill("SIGKILL"), 25_000);
        const done = new Promise<void>((resolve, reject) =>
          child.once("exit", (code, signalName) => {
            clearTimeout(watchdog);
            if (code === 0) {
              resolve();
            } else {
              reject(
                new Error(
                  `${phase} shutdown subprocess exited ${code ?? signalName}${fs.existsSync(path.join(root, phase + ".error")) ? ": " + fs.readFileSync(path.join(root, phase + ".error"), "utf8") : ""}`,
                ),
              );
            }
          }),
        );
        return {
          done,
          signal: (signalName: NodeJS.Signals) => child.kill(signalName),
        };
      };
      const first = launch("first");
      await waitForFile(path.join(root, "child.pid"));
      const processInfo = JSON.parse(
        fs.readFileSync(path.join(root, "child.pid"), "utf8"),
      ) as { descendantPid: number; processGroupId: number };
      const descendantStat = readProcessStat(processInfo.descendantPid);
      expect(descendantStat).not.toBeNull();
      expect(descendantStat?.state).not.toBe("Z");
      expect(hasLiveProcessGroupMember(processInfo.processGroupId)).toBe(true);
      await expect(
        acquireProjectOwnership(
          path.join(root, "coordination"),
          { trelloBoardId: "board", githubRepository: "owner/shutdown" },
          "p3-shutdown",
        ),
      ).rejects.toThrow(/already held/u);
      first.signal("SIGTERM");
      await first.done;
      expect(
        JSON.parse(fs.readFileSync(path.join(root, "first.done"), "utf8")),
      ).toMatchObject({
        runCount: 1,
        dispatchCount: 1,
        terminal: true,
        aborted: true,
        lateClaimCount: 0,
        readyReadCount: expect.any(Number),
        releasedLeaseRejectsWrites: true,
      });
      expect(
        JSON.parse(fs.readFileSync(path.join(root, "first.done"), "utf8"))
          .readyReadCount,
      ).toBeGreaterThan(0);
      const stoppedDescendant = readProcessStat(processInfo.descendantPid);
      expect(
        stoppedDescendant?.state === undefined ||
          stoppedDescendant.state === "Z" ||
          stoppedDescendant.state === "X",
      ).toBe(true);
      expect(hasLiveProcessGroupMember(processInfo.processGroupId)).toBe(false);
      const releasedLease = await acquireProjectOwnership(
        path.join(root, "coordination"),
        { trelloBoardId: "board", githubRepository: "owner/shutdown" },
        "p3-shutdown",
      );
      await releasedLease.release();
      await launch("restart").done;
      expect(
        fs.existsSync(path.join(root, "restart.done")),
        fs.readdirSync(root).join(","),
      ).toBe(true);
      const restarted = JSON.parse(
        fs.readFileSync(path.join(root, "restart.json"), "utf8"),
      ) as {
        attemptId: string;
        pinned: {
          repositoryPath: string;
          boardId: string;
          storageRoot: string;
        };
        sessions: { primary: string };
        secondClaimBlocked: boolean;
      };
      expect(restarted).toMatchObject({
        attemptId: "p3-shutdown-attempt",
        pinned: { repositoryPath: source, boardId: "board" },
        sessions: { primary: "fixture-session" },
        secondClaimBlocked: true,
      });
      expect(fs.readFileSync(path.join(source, "tracked.txt"), "utf8")).toBe(
        "uncommitted implementation in progress\n",
      );
      expect(
        (await execFile("git", ["-C", source, "status", "--porcelain"])).stdout,
      ).toContain("M tracked.txt");
      expect(
        fs.readdirSync(path.join(restarted.pinned.storageRoot, "attempts")),
      ).toEqual(["p3-shutdown-attempt.json"]);
      expect(
        JSON.parse(fs.readFileSync(path.join(root, "restart.done"), "utf8")),
      ).toMatchObject({ dispatchCount: 0, claimCount: 0, lateClaimCount: 0 });
      expect(
        JSON.parse(fs.readFileSync(path.join(root, "restart.done"), "utf8")),
      ).toMatchObject({ runCount: 1, dispatchCount: 0 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});
