import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { OpenCodeClient, type RunOpenCode } from "../src/opencode/opencode-client.js";
import { CommandRunner, type RunCommand } from "../src/process/command-runner.js";
import { beginProcessEvidence } from "../src/process/process-runtime.js";
import { runTaskSessionWorkflow } from "../src/orchestrator/run-task-session-workflow.js";
import {
  PUBLICATION_RECHECK_MS,
  resumeInitialPublication,
} from "../src/orchestrator/initial-publication.js";
import { hasDueTaskSessionRecoveryWait } from "../src/orchestrator/run-orchestrator.js";
import { reconcileTaskSession } from "../src/task-session/reconcile-task-session.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { getTaskSessionSourceSnapshotIdentity } from "../src/task-session/source-snapshot.js";
import { PUBLICATION_WORKTREE_CHANGES_ERROR } from "../src/task-session/uncommitted-publication-recovery.js";
import {
  createPublicationFixture,
  reopenPublicationFixture,
} from "./support/initial-publication-fixture.js";

it.each([true, false])(
  "publishes the preserved implementation as a draft after ownership restart even when refreshed validation passes=%s",
  async (validationPasses) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-publication-restart-"));
    try {
      const original = createPublicationFixture(root);
      original.project.opencode = {
        timeoutMinutes: 1,
        refinement: {},
        implementation: {},
        review: {},
        commit: {},
        remediation: { maxPasses: 1, validationMaxPasses: 2 },
      };
      fs.writeFileSync(path.join(root, "project.json"), JSON.stringify(original.project));
      const sourceHead = await original.git.getHeadSha(original.project.repository.path);
      const identity = await getTaskSessionSourceSnapshotIdentity(
        original.git,
        original.worktreePath,
      );
      const initialWorktreeHead = await original.git.getHeadSha(original.worktreePath);
      await original.authority.run(async () => {
        const store = new TaskExecutionStore(original.project.contextRoot, original.project);
        const record = store.read("card")!;
        store.compareAndSwap("card", record.revision, {
          ...record,
          planningAdvice: { status: "unavailable", diagnostic: "Retained task scope is available" },
          validationRepair: {
            cycleId: "operation",
            status: "exhausted",
            maxAttempts: 2,
            evidence: {
              command: "true",
              startedAt: record.createdAt,
              completedAt: record.updatedAt,
              exitCode: null,
              status: "uncertain",
              diagnostic: "MongoDB/Redis unavailable",
              contentIdentity: identity,
            },
          },
          reviewRepair: {
            cycleId: "operation",
            status: "exhausted",
            stopReason: "no-change",
            maxAttempts: 1,
            finalReview: {
              version: 1,
              projectId: original.project.id,
              cardId: "card",
              verdict: "fail",
              requirementAssessments: [],
              reviewedContentIdentity: identity,
              blockingFindings: [
                {
                  id: "retained-finding",
                  kind: "defect",
                  summary: "Needs human verification",
                  detail: "The earlier validation could not reach its database dependencies",
                },
              ],
            },
          },
          retryCounters: { ...record.retryCounters, validation: 2, review: 1 },
          revision: record.revision + 1,
          updatedAt: new Date(Date.parse(record.updatedAt) + 1).toISOString(),
        });
        await reconcileTaskSession({
          project: original.project,
          cardId: "card",
          operationKey: "operation",
          expectedBranch: "agent/card",
          worktreePath: original.worktreePath,
          taskRecordStore: store,
          retryIntervalMs: 1_000,
          readAuthoritativeSnapshot: async () => {
            throw new Error(PUBLICATION_WORKTREE_CHANGES_ERROR);
          },
        });
        expect(store.read("card")?.phase).toBe("attention-required");
      });
      expect(
        await original.git.getRemoteBranchSha(
          original.project.repository.path,
          "origin",
          "agent/card",
        ),
      ).toBeNull();
      expect(original.services.read().prs).toEqual([]);

      // Reload persisted configuration/state under a different ownership token, as on service startup.
      const restarted = reopenPublicationFixture(root, "restarted-service");
      restarted.services.change({ secondReady: true });
      expect(restarted.store.read()?.owner.generation).toBeGreaterThan(
        original.authority.ownerGeneration,
      );
      expect(hasDueTaskSessionRecoveryWait(restarted.store.read())).toBe(true);
      const agent = vi.fn<RunOpenCode>(async (options) => {
        const evidence = beginProcessEvidence(
          "opencode run",
          options.cwd,
          [],
          path.join(
            new TaskExecutionStore(
              restarted.project.contextRoot,
              restarted.project,
              restarted.authority,
            ).processExecutionDirectory("card")!,
            "process-executions",
          ),
        );
        await options.onExecutionPrepared?.({
          executionId: evidence.executionId,
          metadataPath: evidence.metadataPath,
          artifactRoot: evidence.artifactRoot,
        });
        if (options.prompt.includes("Generate the commit message")) {
          const target = options.prompt.match(/Write exactly one JSON object to ([^\n]+)\./u)?.[1];
          if (!target) throw new Error("Commit message prompt omitted its result path");
          fs.mkdirSync(path.dirname(path.join(options.cwd, target)), { recursive: true });
          fs.writeFileSync(
            path.join(options.cwd, target),
            JSON.stringify({ message: "feat(task): preserve reviewed implementation" }),
          );
        }
        evidence.finish("success", { exitCode: 0, treeStopped: true });
        return { exitCode: 0, output: "{}", errorOutput: "" };
      });
      const commands = vi.fn<RunCommand>(async (options) => {
        if (options.command.startsWith("opencode session list"))
          return {
            exitCode: 0,
            output: JSON.stringify([{ id: "primary", directory: restarted.worktreePath }]),
          };
        expect(options.command).toBe("true");
        return {
          exitCode: validationPasses ? 0 : 1,
          output: validationPasses
            ? "Database connectivity restored; validation passed"
            : "MongoDB/Redis still unavailable",
        };
      });
      await restarted.authority.run(() =>
        runTaskSessionWorkflow({
          project: restarted.project,
          trello: Object.assign(restarted.services.trello, { getCardAttachments: async () => [] }),
          git: restarted.git,
          github: restarted.services.github,
          openCode: new OpenCodeClient(agent),
          commands: new CommandRunner(commands),
          signal: new AbortController().signal,
          prepareAttachmentContext: async () => undefined,
          retryIntervalMs: 1_000,
        }),
      );
      vi.useFakeTimers({ toFake: ["Date"] });
      for (let poll = 0; poll < 20 && restarted.store.read()?.lifecycle !== "ci"; poll += 1) {
        await restarted.authority.run(() =>
          resumeInitialPublication({
            project: restarted.project,
            trello: restarted.services.trello,
            git: restarted.git,
            github: restarted.services.github,
            opencode: new OpenCodeClient(agent),
            signal: new AbortController().signal,
          }),
        );
        vi.setSystemTime(Date.now() + PUBLICATION_RECHECK_MS + 1);
      }
      const record = new TaskExecutionStore(
        restarted.project.contextRoot,
        restarted.project,
        restarted.authority,
      ).read("card")!;
      expect(
        record.phase,
        JSON.stringify({
          reason: record.recoveryAttentionReason,
          wait: restarted.store.read()?.wait,
        }),
      ).toBe("ci");
      expect(record.primarySessionId).toBe("primary");
      expect(record.retryCounters).toMatchObject({ validation: 2, review: 1 });
      expect(record.recoveryAttentionReason).toBeUndefined();
      expect(commands.mock.calls.some(([call]) => call.command === "true")).toBe(true);
      expect(
        agent.mock.calls.every(
          ([call]) =>
            !call.prompt.includes("Implement the approved task plan") &&
            !call.prompt.startsWith("Address the independent implementation review findings"),
        ),
      ).toBe(true);
      const state = restarted.services.read();
      expect(state.prs).toHaveLength(1);
      expect(state.requests).toHaveLength(1);
      expect(state.prs[0]).toMatchObject({ draft: true, head: record.pullRequest!.headSha });
      expect(state.prs[0]!.body).toContain("Needs human verification");
      expect(state.prs[0]!.body).toContain(`Validation: ${validationPasses ? "passed" : "failed"}`);
      expect(state.list).toBe("review");
      expect(await restarted.git.getCurrentBranch(restarted.worktreePath)).toBe("agent/card");
      expect(
        await restarted.git.getCommitCountBetween(
          restarted.worktreePath,
          initialWorktreeHead,
          record.pullRequest!.headSha!,
        ),
      ).toBe(1);
      expect(
        await getTaskSessionSourceSnapshotIdentity(restarted.git, restarted.worktreePath),
      ).toBe(identity);
      expect(fs.readFileSync(path.join(restarted.worktreePath, "source.txt"), "utf8")).toBe(
        "meaningful task implementation\n",
      );
      expect(await restarted.git.getHeadSha(restarted.project.repository.path)).toBe(sourceHead);
      expect(
        fs.readFileSync(path.join(restarted.project.repository.path, "source.txt"), "utf8"),
      ).toBe("original\n");
      const finalRestart = reopenPublicationFixture(root, "third-service");
      await finalRestart.authority.run(() =>
        resumeInitialPublication({
          project: finalRestart.project,
          trello: finalRestart.services.trello,
          git: finalRestart.git,
          github: finalRestart.services.github,
          opencode: new OpenCodeClient(agent),
          signal: new AbortController().signal,
        }),
      );
      expect(finalRestart.services.read().requests).toHaveLength(1);
      expect(
        await finalRestart.git.getCommitCountBetween(
          finalRestart.worktreePath,
          initialWorktreeHead,
          record.pullRequest!.headSha!,
        ),
      ).toBe(1);
    } finally {
      vi.useRealTimers();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
