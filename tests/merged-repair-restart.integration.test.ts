import fs from "node:fs";
import { Logger } from "../src/logging/logger.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import { NotificationOutbox } from "../src/notifications/notification-outbox.js";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  createPublicationFixture,
  reopenPublicationFixture,
} from "./support/initial-publication-fixture.js";
import { runTaskSessionWorkflow } from "../src/orchestrator/run-task-session-workflow.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { CommandRunner } from "../src/process/command-runner.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import {
  transitionTaskExecutionRecord,
  type TaskExecutionEvent,
} from "../src/task-session/task-execution-transition.js";
import { writeTrustedCommitState } from "../src/orchestrator/trusted-commit-state.js";
import {
  recordTerminalPrFence,
  markTerminalWritersStopped,
} from "../src/task-session/terminal-pr-fence.js";

it.each([
  ...(["validation", "attention-required"] as const).flatMap((phase) =>
    [false, true].map((alreadyDone) => ({ phase, alreadyDone, corruptSnapshot: false })),
  ),
  { phase: "validation" as const, alreadyDone: false, corruptSnapshot: true },
])(
  "reconciles merged repair state from $phase with card already Done=$alreadyDone and corrupt snapshot=$corruptSnapshot",
  async ({ phase, alreadyDone, corruptSnapshot }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "merged-repair-restart-"));
    let persistenceFailure: ReturnType<typeof vi.spyOn> | undefined;
    const warnings = vi.spyOn(Logger.prototype, "warn");
    const lifecycleEvents = vi.spyOn(Logger.prototype, "event");
    try {
      let f = createPublicationFixture(root);
      const bindOwnedCard = () => {
        f = {
          ...f,
          authority: new ProjectRunAuthority(
            f.project.id,
            f.store,
            f.authority.ownerGeneration,
            undefined,
            undefined,
            "card",
          ),
        };
      };
      bindOwnedCard();
      const sourceHead = await f.git.getHeadSha(f.project.repository.path);
      f.isolated.git(f.worktreePath, "add", "source.txt");
      f.isolated.git(f.worktreePath, "commit", "-m", "published implementation");
      f.isolated.git(
        f.worktreePath,
        "push",
        path.join(root, "remote.git"),
        "HEAD:refs/heads/agent/card",
      );
      const head = await f.git.getHeadSha(f.worktreePath);
      const pr = {
        url: "https://github.com/owner/repo/pull/1",
        state: "MERGED" as const,
        mergedAt: "2026-11-18T20:30:00.000Z",
        headRefOid: head,
        headRefName: "agent/card",
        baseRefName: "main",
        headRepository: { name: "repo" },
        headRepositoryOwner: { login: "owner" },
      };
      f.services.change({ list: alreadyDone ? "done" : "review", secondReady: true });
      await f.authority.run(async () => {
        const store = new TaskExecutionStore(f.project.contextRoot, f.project);
        let record = store.read("card")!;
        const event = (type: TaskExecutionEvent["type"]) =>
          ({
            type,
            eventId: `${type}:${record.revision}`,
            projectId: f.project.id,
            cardId: "card",
            operationKey: "operation",
            occurredAt: new Date(
              Math.max(Date.now(), Date.parse(record.updatedAt) + 1),
            ).toISOString(),
            ...(type === "publication-completed"
              ? { pullRequest: { number: 1, url: pr.url, headSha: head } }
              : {}),
          }) as TaskExecutionEvent;
        record = store.compareAndSwap(
          "card",
          record.revision,
          transitionTaskExecutionRecord(record, event("publication-completed")),
        );
        writeTrustedCommitState(f.project, "card", {
          version: 1,
          kind: "trusted-commit",
          projectId: f.project.id,
          cardId: "card",
          taskBranch: "agent/card",
          defaultBranch: "main",
          commitSha: head,
        });
        record = store.compareAndSwap(
          "card",
          record.revision,
          transitionTaskExecutionRecord(record, event("ci-failed")),
        );
        record = store.compareAndSwap("card", record.revision, {
          ...record,
          reviewRepair: {
            cycleId: "operation:ci-review:operation:ci",
            status: "active",
            maxAttempts: 3,
          },
          ciRepair: {
            cycleId: "operation:ci",
            headSha: head,
            status: "active",
            maxAttempts: 2,
            activePrimaryOperation: {
              operationId: "operation:ci:pass:1",
              pass: 1,
              sourceIdentity: `sha256:${"a".repeat(64)}`,
            },
          },
          retryCounters: { ...record.retryCounters, ci: 1 },
          primaryOperations: {
            "operation:ci:pass:1": {
              id: "operation:ci:pass:1",
              activity: "ci-correction",
              role: "primary",
              status: "completed",
              executions: 1,
              resultArtifact: store.writePrimaryResultArtifact("ci-result", {
                exitCode: 0,
                output: "CI_REPAIR_FINISHED_EARLY",
                errorOutput: "",
              }),
              updatedAt: record.updatedAt,
            },
          },
          revision: record.revision + 1,
        });
        record = store.compareAndSwap(
          "card",
          record.revision,
          transitionTaskExecutionRecord(record, event("implementation-completed")),
        );
        if (phase === "attention-required")
          store.compareAndSwap("card", record.revision, {
            ...transitionTaskExecutionRecord(record, event("attention-required")),
            recoveryAttentionReason: "Interrupted CI recovery",
          });
        const queue = new TaskMutationQueue(f.project.contextRoot, f.project);
        queue.claimForRecovery("implementation:card");
        queue.complete("implementation:card");
        const eventId = `ci-repair:card:${head}`;
        queue.enqueue({
          projectId: f.project.id,
          cardId: "card",
          eventId,
          operationKey: `operation:ci:${head}`,
          kind: "ci-repair",
          enqueuedAt: record.updatedAt,
        });
        queue.claimForRecovery(eventId);
        queue.fail(eventId);
        if (alreadyDone) {
          // Model an old successful stop proof with no interrupted-state snapshot yet.
          recordTerminalPrFence(f.authority, store.read("card")!, pr, true, "main");
          const proof = f.store.writeArtifact(
            Buffer.from(JSON.stringify({ kind: "task-processes-stopped", cardId: "card" })),
          );
          f.store.referenceMutationArtifact(
            f.store.read()!.revision,
            f.authority.ownerGeneration,
            proof,
          );
          markTerminalWritersStopped(f.authority, proof.id, true);
        }
      });
      fs.writeFileSync(path.join(f.worktreePath, "unshipped.txt"), "preserve interrupted work\n");
      const agent = vi.fn();
      const commands = vi.fn();
      const send = vi.fn(async () => undefined);
      const getCi = vi.fn(async () => {
        throw new Error("Human merge must not wait for CI");
      });
      const poll = () =>
        f.authority.run(() =>
          runTaskSessionWorkflow({
            project: f.project,
            trello: f.services.trello,
            git: f.git,
            github: Object.assign(f.services.github, {
              findPullRequestState: async () => pr,
              getPullRequestCommitShas: async () => [head],
              isAncestorCommit: async () => true,
              getCiObservations: getCi,
            }),
            openCode: new OpenCodeClient(agent),
            commands: new CommandRunner(commands),
            emailNotifier: { send },
            signal: new AbortController().signal,
            prepareAttachmentContext: async () => undefined,
          }),
        );
      if (!alreadyDone) {
        const swap = TaskExecutionStore.prototype.compareAndSwap;
        persistenceFailure = vi
          .spyOn(TaskExecutionStore.prototype, "compareAndSwap")
          .mockImplementation(function (
            this: TaskExecutionStore,
            cardId,
            revision,
            next,
            terminal,
          ) {
            if (next.phase === "done")
              throw new Error("Simulated stop after Trello Done and before terminal persistence");
            return swap.call(this, cardId, revision, next, terminal);
          });
        await expect(poll()).rejects.toThrow("Simulated stop after Trello Done");
        expect(f.services.read().list).toBe("done");
        expect(
          new TaskExecutionStore(f.project.contextRoot, f.project, f.authority).read("card")?.phase,
        ).toBe(phase);
        persistenceFailure.mockRestore();
        persistenceFailure = undefined;
      }
      f = { ...f, ...reopenPublicationFixture(root, "restarted-after-merge") };
      bindOwnedCard();
      if (corruptSnapshot) {
        const retained = new TaskExecutionStore(f.project.contextRoot, f.project, f.authority).read(
          "card",
        )!.terminalInterruption!;
        fs.writeFileSync(retained.artifact.path!, "corrupt terminal evidence");
        await expect(poll()).rejects.toThrow(/artifact|integrity|digest|hash/iu);
        expect(
          new TaskExecutionStore(f.project.contextRoot, f.project, f.authority).read("card")?.phase,
        ).toBe(phase);
        await expect(f.authority.releaseVerifiedTerminal()).rejects.toThrow(
          "verified terminal synchronization",
        );
        expect(fs.readFileSync(path.join(f.worktreePath, "unshipped.txt"), "utf8")).toBe(
          "preserve interrupted work\n",
        );
        return;
      }
      await poll();
      const store = new TaskExecutionStore(f.project.contextRoot, f.project, f.authority);
      const completed = store.read("card")!;
      expect(
        completed.phase,
        JSON.stringify({
          warnings: warnings.mock.calls,
          events: lifecycleEvents.mock.calls,
          wait: f.store.read()?.wait,
          ledger: f.services.entries(),
        }),
      ).toBe("done");
      expect(completed.reviewRepair).toBeUndefined();
      expect(completed.ciRepair).toBeUndefined();
      expect(completed.primaryOperations?.["operation:ci:pass:1"]?.status).toBe("completed");
      const retained = store.readPrimaryResultArtifact({
        bytes: completed.terminalInterruption!.artifact.bytes,
        reference: completed.terminalInterruption!.artifact.reference as `sha256:${string}`,
        ...(completed.terminalInterruption!.artifact.path === undefined
          ? {}
          : { path: completed.terminalInterruption!.artifact.path }),
      });
      expect(retained).toMatchObject({
        kind: "terminal-task-state",
        task: { phase, reviewRepair: { status: "active" }, ciRepair: { status: "active" } },
      });
      expect(f.store.read()).toMatchObject({
        lifecycle: "done",
        publicationState: "merged",
        terminalSync: "verified",
      });
      expect(
        f.authority.run(() => new TaskMutationQueue(f.project.contextRoot, f.project).getActive()),
      ).toBeNull();
      await f.authority.releaseVerifiedTerminal();
      expect(fs.readFileSync(path.join(f.worktreePath, "unshipped.txt"), "utf8")).toBe(
        "preserve interrupted work\n",
      );
      expect(await f.git.getCurrentBranch(f.worktreePath)).toBe("agent/card");
      expect(await f.git.getHeadSha(f.project.repository.path)).toBe(sourceHead);
      f.services.change({ secondReady: false });
      f = { ...f, ...reopenPublicationFixture(root, "third-owner") };
      bindOwnedCard();
      await poll();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        lifecycleEvents.mock.calls.filter(
          ([message]) => message === "Merged task Done state verified and persisted",
        ),
      ).toHaveLength(1);
      // The fixture has no concrete Trello transport receipt: delivery remains
      // prepared, while event creation must still be idempotent across restart.
      expect(send).not.toHaveBeenCalled();
      expect(
        new NotificationOutbox(f.project.contextRoot, f.project.id, () => {})
          .records()
          .filter((record) => record.event === "done"),
      ).toHaveLength(alreadyDone ? 0 : 1);
      expect(f.services.entries().filter((entry) => entry.type === "move-request")).toHaveLength(
        alreadyDone ? 0 : 1,
      );
      expect(agent).not.toHaveBeenCalled();
      expect(commands).not.toHaveBeenCalled();
      expect(getCi).not.toHaveBeenCalled();
    } finally {
      persistenceFailure?.mockRestore();
      warnings.mockRestore();
      lifecycleEvents.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
