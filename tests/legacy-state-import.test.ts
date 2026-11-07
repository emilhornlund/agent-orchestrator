import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  buildLegacyRunSnapshot,
  inventoryLegacyProject,
  migrateLegacyProject,
  migrateLegacyAttempt,
} from "../src/task-session/legacy-state-import.js";
import { RunRegistry, RunStore } from "../src/task-session/run-store.js";
import type { ProjectConfig } from "../src/config/config.js";
import { provisionCoordinationNamespace } from "../src/coordination/project-ownership.js";
import { writeReconciliationBlock } from "../src/orchestrator/reconciliation-block-storage.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import { TaskPlanStore } from "../src/task-session/task-plan-store.js";
import { FeedbackLedgerStore } from "../src/task-session/feedback-ledger-store.js";
import { PrMaintenanceStore } from "../src/task-session/pr-maintenance-store.js";
import { TaskMutationBlockStore } from "../src/orchestrator/task-mutation-block-store.js";
import {
  writePendingCommitState,
  writeRejectedCommitState,
  writeTrustedCommitState,
} from "../src/orchestrator/trusted-commit-state.js";
import { writePreparedConflict } from "../src/orchestrator/prepared-conflict-state.js";
import { readPreparedConflict } from "../src/orchestrator/prepared-conflict-state.js";
import {
  readPendingCommitState,
  readRejectedCommitState,
  readTrustedCommitState,
} from "../src/orchestrator/trusted-commit-state.js";
import { loadReconciliationBlock } from "../src/orchestrator/reconciliation-block-storage.js";
import type { TaskExecutionRecord } from "../src/task-session/task-execution-record.js";

const legacy = {
  version: 1,
  projectId: "project-one",
  cardId: "card-one",
  phase: "human-feedback",
  primarySessionId: "session-primary",
  expectedBranch: "agent/card-one",
  pullRequest: {
    number: 42,
    url: "https://github.com/owner/repository/pull/42",
    headSha: "a".repeat(40),
  },
  operationKey: "feedback-42-1",
  lastEvent: {
    id: "event-one",
    type: "feedback-received",
    operationKey: "feedback-42-1",
    occurredAt: "2026-10-24T09:04:00.000Z",
  },
  setup: { command: "yarn install", status: "passed" },
  feedbackRecoveryAttemptEventId: "event-one",
  humanReviewNotificationCommitShas: ["a".repeat(40)],
  revision: 3,
  retryCounters: { validation: 1, review: 0, ci: 2, humanFeedback: 1 },
  createdAt: "2026-10-24T09:00:00.000Z",
  updatedAt: "2026-10-24T09:05:00.000Z",
};
const pinned = {
  integrationId: "canonical-project",
  projectId: "project-one",
  boardId: "board",
  lists: {
    ready: "ready",
    working: "working",
    review: "review",
    failed: "failed",
    done: "done",
    backlog: "backlog",
  },
  repository: "owner/repository",
  repositoryPath: "/repo",
  worktreeRoot: "/worktrees",
  storageRoot: "/state",
};
const lease = {
  integrationId: "canonical-project",
  instanceId: "instance",
  token: "token",
  assertHeld() {},
};

function writeLegacyTaskWithRealStore(
  runtimeRoot: string,
  project: ProjectConfig,
): void {
  const store = new TaskExecutionStore(runtimeRoot, project);
  store.create({ ...legacy, revision: 1 } as unknown as TaskExecutionRecord);
  for (let revision = 1; revision < legacy.revision; revision += 1) {
    const current = store.read(legacy.cardId)!;
    store.compareAndSwap(legacy.cardId, revision, {
      ...current,
      revision: revision + 1,
      updatedAt: legacy.updatedAt,
    });
  }
}

describe("legacy state import", () => {
  it("preserves progress/session/PR and maps active legacy phase to explicit reconciliation wait", () => {
    const bytes = Buffer.from(JSON.stringify(legacy));
    const sources = [
      {
        family: "task-executions",
        path: "/legacy/task.json",
        projectId: "project-one",
        cardId: "card-one",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes,
        parsed: legacy,
      },
    ];
    const built = buildLegacyRunSnapshot({
      rawTask: legacy,
      sources,
      pinned,
      lease,
      now: new Date("2026-11-01T00:00:00.000Z"),
    });
    expect(built.record.lifecycle).toBe("waiting");
    expect(built.record.checkpoint).toBe("human-feedback");
    expect(built.record.wait.reason).toBe("legacy-execution-reconciliation");
    expect(built.record.publicationState).toBe("unknown");
    expect(built.record.sessions.primary).toBe("session-primary");
    expect(built.record.legacy.retryCounters).toEqual(legacy.retryCounters);
    expect(built.record.legacy.legacyTaskRecord).toEqual(legacy);
    expect(built.record.legacy.sourceManifest).toHaveLength(1);
    const snapshot = JSON.parse(
      Buffer.from(built.artifacts[0]!.content).toString(),
    ) as { sources: { bytesBase64: string }[] };
    expect(Buffer.from(snapshot.sources[0]!.bytesBase64, "base64")).toEqual(
      bytes,
    );
  });

  it("rejects unsupported records rather than turning them into an empty/new claim", () => {
    expect(() =>
      buildLegacyRunSnapshot({
        rawTask: { ...legacy, version: 9 },
        sources: [],
        pinned,
        lease,
      }),
    ).toThrow();
  });

  it.each([
    ["planning", "planning"],
    ["implementation", "implementation"],
    ["validation", "validation"],
    ["review", "review"],
    ["publication", "publication"],
    ["ci", "ci"],
    ["human-feedback", "human-feedback"],
    ["attention-required", "implementation"],
    ["done", "human-review"],
  ] as const)(
    "maps legacy %s to a visible nonterminal checkpoint",
    (phase, expected) => {
      const raw = { ...legacy, phase };
      const bytes = Buffer.from(JSON.stringify(raw));
      const sources = [
        {
          family: "task-executions",
          path: "/legacy/task.json",
          projectId: raw.projectId,
          cardId: raw.cardId,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes,
          parsed: raw,
        },
      ];
      const mapped = buildLegacyRunSnapshot({
        rawTask: raw,
        sources,
        pinned,
        lease,
        now: new Date("2026-11-01T00:00:00.000Z"),
      });
      expect(mapped.record.lifecycle).toBe("waiting");
      expect(mapped.record.checkpoint).toBe(expected);
      expect(mapped.record.wait.reason).toBe(
        phase === "done"
          ? "legacy-terminal-unverified"
          : phase === "attention-required"
            ? "legacy-attention-required"
            : "legacy-execution-reconciliation",
      );
      expect(mapped.record.legacy.recoveryDisposition).toBe(
        phase === "done" || phase === "attention-required"
          ? "operator-reconciliation-required"
          : "task-session-reconcile",
      );
    },
  );

  it("restarts across each durable handoff barrier without replaying external writes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-handoff-"));
    try {
      const storageRoot = path.join(root, "state");
      const taskBytes = Buffer.from(JSON.stringify(legacy));
      const sources = [
        {
          family: "task-executions",
          path: path.join(root, "task.json"),
          projectId: "project-one",
          cardId: "card-one",
          sha256: createHash("sha256").update(taskBytes).digest("hex"),
          bytes: taskBytes,
          parsed: legacy,
        },
      ];
      const candidate = buildLegacyRunSnapshot({
        rawTask: legacy,
        sources,
        pinned: {
          ...pinned,
          storageRoot,
          repositoryPath: path.join(root, "repo"),
          worktreeRoot: path.join(root, "worktrees"),
        },
        lease,
      });
      const store = new RunStore(
        storageRoot,
        candidate.record.attemptId,
        candidate.record.pinned,
        lease,
      );
      const registry = new RunRegistry(storageRoot, lease.integrationId, lease);
      const killed = new Set<string>();
      let result;
      for (let retry = 0; retry < 8; retry += 1) {
        try {
          result = migrateLegacyAttempt({
            store,
            registry,
            lease,
            candidate,
            markerRoot: storageRoot,
            afterDurableStage: (current) => {
              if (!killed.has(current)) {
                killed.add(current);
                throw new Error("simulated process kill");
              }
            },
          });
          break;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "simulated process kill"
          )
            throw error;
        }
      }
      expect(killed).toEqual(
        new Set([
          "artifacts-durable",
          "snapshots-complete",
          "candidate-durable",
          "candidate-installed",
          "pointer-durable",
          "pointer-published",
          "complete",
        ]),
      );
      expect(result?.wait.reason).toBe("legacy-execution-reconciliation");
      expect(registry.reconcile()?.attemptId).toBe(candidate.record.attemptId);
      const successorLease = {
        ...lease,
        instanceId: "successor",
        token: "successor-token",
      };
      const successorStore = new RunStore(
        storageRoot,
        candidate.record.attemptId,
        candidate.record.pinned,
        successorLease,
      );
      const successorRegistry = new RunRegistry(
        storageRoot,
        successorLease.integrationId,
        successorLease,
      );
      const resumed = migrateLegacyAttempt({
        store: successorStore,
        registry: successorRegistry,
        lease: successorLease,
        candidate,
        markerRoot: storageRoot,
      });
      expect(resumed.owner.generation).toBe(2);
      expect(resumed.owner.instanceId).toBe("successor");
      const currentGeneration = resumed.owner.generation;
      const conflictingSources = sources.map((source) => ({
        ...source,
        path: `${source.path}.different`,
      }));
      const conflictingCandidate = buildLegacyRunSnapshot({
        rawTask: legacy,
        sources: conflictingSources,
        pinned: candidate.record.pinned,
        lease: successorLease,
      });
      expect(() =>
        migrateLegacyAttempt({
          store: successorStore,
          registry: successorRegistry,
          lease: successorLease,
          candidate: conflictingCandidate,
          markerRoot: storageRoot,
        }),
      ).toThrow(/Conflicting migration marker/);
      expect(successorStore.read()?.owner.generation).toBe(currentGeneration);
      const beforeProgress = successorStore.read()!;
      const progressed = successorStore.transition(
        beforeProgress.revision,
        beforeProgress.owner.generation,
        null,
        "wait-resumed",
        "waiting",
        "human-feedback",
        (current) => current,
      );
      expect(progressed.revision).toBeGreaterThan(beforeProgress.revision);
      fs.unlinkSync(
        path.join(
          storageRoot,
          "attempts",
          `${candidate.record.attemptId}.json`,
        ),
      );
      expect(() =>
        migrateLegacyAttempt({
          store: successorStore,
          registry: successorRegistry,
          lease: successorLease,
          candidate,
          markerRoot: storageRoot,
        }),
      ).toThrow(/candidate that is missing/);
      expect(
        fs.existsSync(
          path.join(
            storageRoot,
            "attempts",
            `${candidate.record.attemptId}.json`,
          ),
        ),
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses configured topology and selects exact project filenames before parsing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-topology-"));
    try {
      const runtime = path.join(root, "runtime");
      const worktrees = path.join(root, "worktrees");
      const projectId = "project-one";
      const project = {
        id: projectId,
        repository: {
          path: path.join(root, "repo"),
          worktreeRoot: worktrees,
          defaultBranch: "main",
        },
      } as unknown as ProjectConfig;
      fs.mkdirSync(project.repository.path, { recursive: true });
      fs.mkdirSync(project.repository.worktreeRoot, { recursive: true });
      writeLegacyTaskWithRealStore(runtime, project);
      const queues = path.join(runtime, "task-mutation-queues");
      fs.mkdirSync(queues, { recursive: true });
      const mutationQueue = new TaskMutationQueue(runtime, project);
      mutationQueue.enqueue({
        projectId,
        eventId: "feedback-1",
        cardId: "card-one",
        kind: "feedback",
        operationKey: "feedback-op-1",
        enqueuedAt: legacy.updatedAt,
      });
      const originalQueueBytes = fs.readFileSync(
        path.join(queues, "project-one.json"),
      );
      fs.writeFileSync(
        path.join(queues, "other-project.json"),
        "{ malformed unrelated queue",
      );
      new TaskMutationBlockStore(runtime, projectId).report(
        "migration-scope",
        "migration-identity",
        "normal v1 block",
      );
      const maintenance = path.join(runtime, "pr-maintenance");
      fs.mkdirSync(maintenance, { recursive: true });
      new PrMaintenanceStore(runtime, project).create({
        projectId,
        cardId: "card-one",
        pullRequest: {
          number: 42,
          url: "https://github.com/owner/repository/pull/42",
        },
        expectedRemoteHead: "a".repeat(40),
        targetBaseHead: "b".repeat(40),
        operationId: "maintenance-one",
        createdAt: legacy.updatedAt,
        updatedAt: legacy.updatedAt,
        localPreparation: {
          status: "prepared",
          originalHead: "a".repeat(40),
          baseHead: "b".repeat(40),
          resultingHead: "a".repeat(40),
          backupRef: "refs/agent-backup-card-one",
          updatedAt: legacy.updatedAt,
        },
        publication: {
          status: "push-intended",
          resultingHead: "b".repeat(40),
          updatedAt: legacy.updatedAt,
        },
      });
      const planDir = path.join(runtime, "task-plans", projectId);
      fs.mkdirSync(planDir, { recursive: true });
      new TaskPlanStore(runtime, project).create(
        {
          version: 1,
          projectId,
          cardId: "card-one",
          requirements: [
            { id: "REQ-1", text: "Preserve", verification: "Compare" },
          ],
          steps: [
            {
              id: "STEP-1",
              description: "Import",
              requirementIds: ["REQ-1"],
              verification: "Test",
            },
          ],
          assumptions: [],
          blockers: [],
        },
        3,
      );
      const feedbackDir = path.join(runtime, "feedback-ledgers", projectId);
      fs.mkdirSync(feedbackDir, { recursive: true });
      new FeedbackLedgerStore(runtime, project).create("card-one", [
        {
          kind: "conversation-comment",
          id: "comment-one",
          author: "reviewer",
          createdAt: legacy.updatedAt,
          updatedAt: null,
          body: "please inspect",
          actionability: "unclassified",
          status: "pending",
          verificationEvidence: [],
          replyState: "outcome-unknown",
          replyOperationId: "reply-one",
        },
      ]);
      writeTrustedCommitState(project, "card-one", {
        version: 1,
        kind: "trusted-commit",
        projectId,
        cardId: "card-one",
        taskBranch: "agent/card-one",
        defaultBranch: "main",
        commitSha: "trusted",
      });
      writePendingCommitState(project, "card-one", {
        version: 1,
        kind: "pending-commit",
        projectId,
        cardId: "card-one",
        taskBranch: "agent/card-one",
        defaultBranch: "main",
        parentSha: "a".repeat(40),
      });
      writeRejectedCommitState(project, "card-one", {
        version: 1,
        kind: "rejected-commit",
        projectId,
        cardId: "card-one",
        taskBranch: "agent/card-one",
        defaultBranch: "main",
        commitSha: "rejected",
      });
      writePreparedConflict(
        project,
        "card-one",
        ["file.ts"],
        {
          active: true,
          backend: "merge",
          headName: "agent/card-one",
          onto: "b".repeat(40),
          originalHead: "a".repeat(40),
          currentStep: 1,
          totalSteps: 1,
        },
        {
          trustedTaskCommitSha: "a".repeat(40),
          rebaseTargetSha: "b".repeat(40),
        },
      );
      const referencedLog = path.join(root, "session.log");
      fs.writeFileSync(referencedLog, "preserved diagnostic bytes");
      writeReconciliationBlock(runtime, {
        version: 1,
        projectId,
        attemptKey: "card-one:pull request",
        attempt: 3,
        operation: "GitHub pull request",
        cardId: "card-one",
        failureCategory: "Git/GitHub",
        failureReason: "temporarily unavailable",
        recoveryCondition: "card-moved-to-ready",
        notificationIdentity: "notification-one",
        failureIdentity: "failure-one",
        sessionLogPaths: [referencedLog],
      });
      const result = inventoryLegacyProject({ runtimeRoot: runtime, project });
      expect(result.blockers).toEqual([]);
      expect(result.records.map((entry) => entry.family).sort()).toEqual([
        "feedback-ledgers",
        "pending-commits",
        "pr-maintenance",
        "prepared-conflicts",
        "reconciliation-block",
        "rejected-commits",
        "session-artifacts",
        "task-executions",
        "task-mutation-blocks",
        "task-mutation-queues",
        "task-plans",
        "trusted-commits",
      ]);
      const integrationId = JSON.stringify({
        trelloBoardId: "board",
        githubRepository: "owner/repository",
      });
      const migrationLease = { ...lease, integrationId };
      const migrationPinned = {
        ...pinned,
        integrationId,
        repositoryPath: project.repository.path,
        worktreeRoot: project.repository.worktreeRoot,
        storageRoot: runtime,
      };
      const migrationRegistry = new RunRegistry(
        runtime,
        integrationId,
        migrationLease,
      );
      const importedAttempt = migrateLegacyProject({
        runtimeRoot: runtime,
        project,
        pinned: migrationPinned,
        lease: migrationLease,
        store: new RunStore(
          runtime,
          "migration-candidate",
          migrationPinned,
          migrationLease,
        ),
        storeForAttempt: (attemptId) =>
          new RunStore(runtime, attemptId, migrationPinned, migrationLease),
        registry: migrationRegistry,
      });
      expect(importedAttempt.status).toBe("imported");
      if (importedAttempt.status !== "imported")
        throw new Error("expected imported attempt");
      expect(importedAttempt.record).toMatchObject({
        lifecycle: "waiting",
        publicationState: "unknown",
        checkpoint: "human-feedback",
        wait: { reason: "legacy-prepared-conflict-reconciliation" },
        legacy: { recoveryDisposition: "operator-reconciliation-required" },
      });
      for (const projectionKey of [
        "task-execution-card-one",
        ProjectRunAuthority.queueKey(projectId),
        ProjectRunAuthority.mutationBlocksKey(projectId),
        ProjectRunAuthority.taskKey("maintenance", projectId),
        ProjectRunAuthority.taskKey("task-plan", "card-one"),
        ProjectRunAuthority.taskKey("feedback-ledger", "card-one"),
        ProjectRunAuthority.commitKey("trusted-commit", "card-one"),
        ProjectRunAuthority.commitKey("pending-commit", "card-one"),
        ProjectRunAuthority.commitKey("rejected-commit", "card-one"),
        `prepared-conflict-card-one`,
        ProjectRunAuthority.reconciliationBlockKey(projectId),
      ])
        expect(
          importedAttempt.record.compatibility[projectionKey],
        ).toBeDefined();
      for (const source of result.records)
        expect(fs.readFileSync(source.path)).toEqual(Buffer.from(source.bytes));
      const migratedStore = new RunStore(
        runtime,
        importedAttempt.record.attemptId,
        migrationPinned,
        migrationLease,
      );
      const generation = importedAttempt.record.owner.generation;
      expect(
        migratedStore.readCompatibility(
          generation,
          ProjectRunAuthority.queueKey(projectId),
          (value) => value,
        ),
      ).toEqual(
        result.records.find(
          (source) => source.family === "task-mutation-queues",
        )?.parsed,
      );
      const importedAuthority = new ProjectRunAuthority(
        projectId,
        migratedStore,
        generation,
      );
      importedAuthority.run(() => {
        expect(
          new TaskExecutionStore(runtime, project).read("card-one"),
        ).toEqual(legacy);
        expect(new TaskMutationQueue(runtime, project).list()).toHaveLength(1);
        expect(
          new TaskPlanStore(runtime, project).read("card-one"),
        ).not.toBeNull();
        expect(
          new FeedbackLedgerStore(runtime, project).read("card-one"),
        ).not.toBeNull();
        expect(new PrMaintenanceStore(runtime, project).inspect()).toHaveLength(
          1,
        );
        expect(
          new TaskMutationBlockStore(runtime, projectId).report(
            "migration-scope",
            "migration-identity",
            "normal v1 block",
          ),
        ).toBe(false);
        expect(readTrustedCommitState(project, "card-one")).not.toBeNull();
        expect(readPendingCommitState(project, "card-one")).not.toBeNull();
        expect(readRejectedCommitState(project, "card-one")).not.toBeNull();
        expect(readPreparedConflict(project, "card-one")).not.toBeNull();
        expect(loadReconciliationBlock(runtime, projectId).status).toBe(
          "loaded",
        );
      });
      const maintenanceFile = path.join(maintenance, "project-one.json");
      const originalMaintenance = JSON.parse(
        fs.readFileSync(maintenanceFile, "utf8"),
      ) as {
        operations: {
          pullRequest: { number: number; url: string };
          expectedRemoteHead: string;
        }[];
      };
      originalMaintenance.operations[0]!.pullRequest.number = 43;
      originalMaintenance.operations[0]!.pullRequest.url =
        "https://github.com/owner/repository/pull/43";
      originalMaintenance.operations[0]!.expectedRemoteHead = "c".repeat(40);
      fs.writeFileSync(maintenanceFile, JSON.stringify(originalMaintenance));
      expect(
        inventoryLegacyProject({ runtimeRoot: runtime, project }).blockers.join(
          " ",
        ),
      ).toContain("conflicting PR");
      fs.writeFileSync(
        maintenanceFile,
        JSON.stringify({
          ...originalMaintenance,
          operations: [
            {
              ...originalMaintenance.operations[0],
              pullRequest: {
                number: 42,
                url: "https://github.com/owner/repository/pull/42",
              },
              expectedRemoteHead: "a".repeat(40),
            },
          ],
        }),
      );
      const headOnlyConflict = JSON.parse(
        fs.readFileSync(maintenanceFile, "utf8"),
      ) as { operations: { expectedRemoteHead: string }[] };
      headOnlyConflict.operations[0]!.expectedRemoteHead = "c".repeat(40);
      fs.writeFileSync(maintenanceFile, JSON.stringify(headOnlyConflict));
      expect(
        new PrMaintenanceStore(runtime, project).inspect()[0]
          ?.expectedRemoteHead,
      ).toBe("c".repeat(40));
      expect(
        new TaskExecutionStore(runtime, project).read("card-one")?.pullRequest
          ?.headSha,
      ).toBe("a".repeat(40));
      expect(
        inventoryLegacyProject({ runtimeRoot: runtime, project }).blockers.join(
          " ",
        ),
      ).toContain("conflicting PR number, URL, or head");
      headOnlyConflict.operations[0]!.expectedRemoteHead = "a".repeat(40);
      fs.writeFileSync(maintenanceFile, JSON.stringify(headOnlyConflict));
      const selectedQueue = path.join(queues, "project-one.json");
      fs.writeFileSync(selectedQueue, "{");
      expect(
        inventoryLegacyProject({ runtimeRoot: runtime, project }).blockers.join(
          " ",
        ),
      ).toContain("project-one.json");
      expect(fs.readFileSync(selectedQueue, "utf8")).toBe("{");
      fs.unlinkSync(referencedLog);
      expect(
        inventoryLegacyProject({ runtimeRoot: runtime, project }).blockers.join(
          " ",
        ),
      ).toContain("referenced artifact");
      fs.writeFileSync(referencedLog, "preserved diagnostic bytes");
      fs.writeFileSync(
        path.join(queues, "project-one.json"),
        JSON.stringify({
          version: 1,
          projectId: "other-project",
          revision: 1,
          activeEventId: null,
          events: [],
        }),
      );
      expect(
        inventoryLegacyProject({ runtimeRoot: runtime, project }).blockers.join(
          " ",
        ),
      ).toContain("configured project-one");
      fs.writeFileSync(
        path.join(queues, "project-one.json"),
        originalQueueBytes,
      );
      const selectedFile = path.join(queues, "project-one.json");
      const selectedBackup = path.join(queues, "project-one.saved");
      fs.renameSync(selectedFile, selectedBackup);
      fs.mkdirSync(selectedFile);
      expect(
        inventoryLegacyProject({ runtimeRoot: runtime, project }).blockers.join(
          " ",
        ),
      ).toContain("unsafe, non-file");
      fs.rmdirSync(selectedFile);
      fs.renameSync(selectedBackup, selectedFile);
      const unrelated = path.join(queues, "other-project.json");
      fs.unlinkSync(unrelated);
      const unrelatedTarget = path.join(root, "unrelated-target");
      fs.writeFileSync(unrelatedTarget, "not project state");
      fs.symlinkSync(unrelatedTarget, unrelated);
      expect(
        inventoryLegacyProject({ runtimeRoot: runtime, project }).blockers,
      ).toEqual([]);
      fs.unlinkSync(unrelated);
      const projectPinned = {
        ...pinned,
        integrationId: lease.integrationId,
        projectId,
        repositoryPath: project.repository.path,
        worktreeRoot: project.repository.worktreeRoot,
        storageRoot: path.join(root, "state"),
      };
      const attemptId = `legacy-${createHash("sha256").update(`${projectId}\0${legacy.cardId}\0${legacy.createdAt}`).digest("hex").slice(0, 32)}`;
      const runStore = new RunStore(
        projectPinned.storageRoot,
        attemptId,
        projectPinned,
        lease,
      );
      const runRegistry = new RunRegistry(
        projectPinned.storageRoot,
        lease.integrationId,
        lease,
      );
      const migrated = migrateLegacyProject({
        runtimeRoot: runtime,
        project,
        pinned: projectPinned,
        lease,
        store: runStore,
        registry: runRegistry,
        now: new Date("2026-11-01T00:00:00.000Z"),
      });
      expect(migrated.status).toBe("imported");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks a card-scoped .json directory instead of interpreting it as no legacy task", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "legacy-nonfile-authority-"),
    );
    try {
      const projectId = "project-one";
      const repositoryPath = path.join(root, "repo");
      const worktreeRoot = path.join(root, "worktrees");
      const storageRoot = path.join(root, "state");
      const runtimeRoot = path.join(root, "runtime");
      fs.mkdirSync(repositoryPath);
      fs.mkdirSync(worktreeRoot);
      const project = {
        id: projectId,
        repository: {
          path: repositoryPath,
          worktreeRoot,
          defaultBranch: "main",
        },
      } as unknown as ProjectConfig;
      fs.mkdirSync(
        path.join(runtimeRoot, "task-executions", projectId, "card-one.json"),
        { recursive: true },
      );
      const pinnedIdentity = {
        ...pinned,
        projectId,
        repositoryPath,
        worktreeRoot,
        storageRoot,
      };
      const malformedAttempt = new RunStore(
        storageRoot,
        "legacy-attempt",
        pinnedIdentity,
        lease,
      );
      const registry = new RunRegistry(storageRoot, lease.integrationId, lease);
      expect(
        inventoryLegacyProject({ runtimeRoot, project }).blockers.join(" "),
      ).toContain("card-one.json");
      expect(() =>
        migrateLegacyProject({
          runtimeRoot,
          project,
          pinned: pinnedIdentity,
          lease,
          store: malformedAttempt,
          registry,
        }),
      ).toThrow(/Legacy project migration blocked/);
      expect(malformedAttempt.read()).toBeNull();
      expect(registry.read()).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("survives external SIGKILL at each durable boundary under canonical ownership", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-process-kill-"));
    try {
      const sourceRoot = path.resolve("src");
      const script = path.join(root, "migration-child.mts");
      fs.writeFileSync(
        script,
        `
        import fs from "node:fs";
        import path from "node:path";
        import { randomUUID, createHash } from "node:crypto";
        import { acquireProjectOwnership } from ${JSON.stringify(path.join(sourceRoot, "coordination/project-ownership.ts"))};
        import { RunRegistry, RunStore } from ${JSON.stringify(path.join(sourceRoot, "task-session/run-store.ts"))};
        import { migrateLegacyProject } from ${JSON.stringify(path.join(sourceRoot, "task-session/legacy-state-import.ts"))};
        const root = process.env.MIGRATION_ROOT!;
        const projectId = "project-one";
        const integrationId = "canonical-project";
        const ownership = await acquireProjectOwnership(path.join(root, "coordination"), { trelloBoardId: "board", githubRepository: "owner/repository" }, "migration-test");
        const lease = { integrationId, instanceId: String(process.pid), token: randomUUID(), assertHeld: () => ownership.assertHeld() };
        const project = { id: projectId, repository: { path: path.join(root, "repo"), worktreeRoot: path.join(root, "worktrees"), defaultBranch: "main" } };
        const pinned = { integrationId, projectId, boardId: "board", lists: { ready: "ready", working: "working", review: "review", failed: "failed", done: "done", backlog: "backlog" }, repository: "owner/repository", repositoryPath: project.repository.path, worktreeRoot: project.repository.worktreeRoot, storageRoot: path.join(root, "state") };
        const taskPath = path.join(root, "runtime", "task-executions", projectId, "card-one.json");
        const task = JSON.parse(fs.readFileSync(taskPath, "utf8"));
        const attempt = "legacy-" + createHash("sha256").update(projectId + "\\0" + task.cardId + "\\0" + task.createdAt).digest("hex").slice(0, 32);
        const store = new RunStore(pinned.storageRoot, attempt, pinned, lease);
        const registry = new RunRegistry(pinned.storageRoot, integrationId, lease);
        migrateLegacyProject({ runtimeRoot: path.join(root, "runtime"), project, pinned, lease, store, registry, afterDurableStage: (stage) => { if (process.env.KILL_STAGE === stage) { fs.writeFileSync(process.env.BARRIER_FILE!, stage); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); } } });
        await ownership.release();
      `,
      );
      const coordination = path.join(root, "coordination");
      fs.mkdirSync(coordination);
      provisionCoordinationNamespace(coordination, "migration-test");
      const runtime = path.join(root, "runtime");
      const project = {
        id: "project-one",
        repository: {
          path: path.join(root, "repo"),
          worktreeRoot: path.join(root, "worktrees"),
          defaultBranch: "main",
        },
      } as unknown as ProjectConfig;
      fs.mkdirSync(project.repository.path, { recursive: true });
      fs.mkdirSync(project.repository.worktreeRoot, { recursive: true });
      writeLegacyTaskWithRealStore(runtime, project);
      const queue = new TaskMutationQueue(runtime, project);
      queue.enqueue({
        projectId: project.id,
        eventId: "feedback-event",
        cardId: "card-one",
        kind: "feedback",
        operationKey: "feedback-operation",
        enqueuedAt: legacy.updatedAt,
      });
      new TaskMutationBlockStore(runtime, project.id).report(
        "scope",
        "identity",
        "retain this blocker",
      );
      new TaskPlanStore(runtime, project).create(
        {
          version: 1,
          projectId: project.id,
          cardId: "card-one",
          requirements: [
            { id: "REQ-1", text: "Keep scope", verification: "Compare" },
          ],
          steps: [
            {
              id: "STEP-1",
              description: "Implement",
              requirementIds: ["REQ-1"],
              verification: "Test",
            },
          ],
          assumptions: [],
          blockers: [],
        },
        legacy.revision,
      );
      new FeedbackLedgerStore(runtime, project).create("card-one", [
        {
          kind: "conversation-comment",
          id: "uncertain-reply",
          author: "reviewer",
          createdAt: legacy.updatedAt,
          updatedAt: null,
          body: "retain",
          actionability: "unclassified",
          status: "pending",
          verificationEvidence: [],
          replyState: "outcome-unknown",
          replyOperationId: "reply-1",
        },
      ]);
      new PrMaintenanceStore(runtime, project).create({
        projectId: project.id,
        cardId: "card-one",
        pullRequest: {
          number: 42,
          url: "https://github.com/owner/repository/pull/42",
        },
        expectedRemoteHead: "a".repeat(40),
        targetBaseHead: "b".repeat(40),
        operationId: "maintenance-1",
        createdAt: legacy.updatedAt,
        updatedAt: legacy.updatedAt,
        localPreparation: {
          status: "prepared",
          originalHead: "a".repeat(40),
          baseHead: "b".repeat(40),
          resultingHead: "a".repeat(40),
          backupRef: "refs/agent-backup-card-one",
          updatedAt: legacy.updatedAt,
        },
        publication: {
          status: "push-intended",
          resultingHead: "b".repeat(40),
          updatedAt: legacy.updatedAt,
        },
      });
      writeTrustedCommitState(project, "card-one", {
        version: 1,
        kind: "trusted-commit",
        projectId: project.id,
        cardId: "card-one",
        taskBranch: "agent/card-one",
        defaultBranch: "main",
        commitSha: "trusted",
      });
      writePendingCommitState(project, "card-one", {
        version: 1,
        kind: "pending-commit",
        projectId: project.id,
        cardId: "card-one",
        taskBranch: "agent/card-one",
        defaultBranch: "main",
        parentSha: "a".repeat(40),
      });
      writeRejectedCommitState(project, "card-one", {
        version: 1,
        kind: "rejected-commit",
        projectId: project.id,
        cardId: "card-one",
        taskBranch: "agent/card-one",
        defaultBranch: "main",
        commitSha: "rejected",
      });
      writePreparedConflict(
        project,
        "card-one",
        ["file.ts"],
        {
          active: true,
          backend: "merge",
          headName: "agent/card-one",
          onto: "b".repeat(40),
          originalHead: "a".repeat(40),
          currentStep: 1,
          totalSteps: 1,
        },
        {
          trustedTaskCommitSha: "a".repeat(40),
          rebaseTargetSha: "b".repeat(40),
        },
      );
      const sessionLog = path.join(root, "session.log");
      fs.writeFileSync(sessionLog, "original session diagnostic");
      writeReconciliationBlock(runtime, {
        version: 1,
        projectId: project.id,
        attemptKey: "card-one:pull request",
        attempt: 3,
        operation: "GitHub pull request",
        cardId: "card-one",
        failureCategory: "Git/GitHub",
        failureReason: "unavailable",
        recoveryCondition: "card-moved-to-ready",
        notificationIdentity: "notify-one",
        failureIdentity: "failure-one",
        sessionLogPaths: [sessionLog],
      });
      const initialInventory = inventoryLegacyProject({
        runtimeRoot: runtime,
        project,
      });
      expect(initialInventory.blockers).toEqual([]);
      const originalSources = new Map(
        initialInventory.records.map((source) => [
          source.path,
          Buffer.from(source.bytes),
        ]),
      );
      const stages = [
        "artifacts-durable",
        "snapshots-complete",
        "candidate-durable",
        "candidate-installed",
        "pointer-durable",
        "pointer-published",
        "complete",
      ];
      for (const stage of stages) {
        const barrier = path.join(root, `barrier-${stage}`);
        const child = spawn(
          path.join(process.cwd(), "node_modules/.bin/tsx"),
          [script],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              MIGRATION_ROOT: root,
              KILL_STAGE: stage,
              BARRIER_FILE: barrier,
            },
            stdio: "ignore",
            detached: true,
          },
        );
        for (
          let attempt = 0;
          attempt < 1_000 && !fs.existsSync(barrier);
          attempt += 1
        ) {
          if (child.exitCode !== null) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(
          fs.existsSync(barrier),
          `${stage}: child failed to reach durable barrier; exit=${String(child.exitCode)}`,
        ).toBe(true);
        process.kill(-child.pid!, "SIGKILL");
        const [, signal] = await once(child, "exit");
        expect(signal).toBe("SIGKILL");
      }
      const retry = spawn(
        path.join(process.cwd(), "node_modules/.bin/tsx"),
        [script],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            MIGRATION_ROOT: root,
            KILL_STAGE: "",
            BARRIER_FILE: path.join(root, "unused"),
          },
          stdio: "ignore",
        },
      );
      const [code, signal] = await once(retry, "exit");
      expect(signal).toBeNull();
      expect(code).toBe(0);
      const finalInventory = inventoryLegacyProject({
        runtimeRoot: runtime,
        project,
      });
      expect(finalInventory.blockers).toEqual([]);
      expect(
        new Map(
          finalInventory.records.map((source) => [
            source.path,
            Buffer.from(source.bytes),
          ]),
        ),
      ).toEqual(originalSources);
      const integrationId = "canonical-project";
      const attemptId = `legacy-${createHash("sha256").update(`project-one\0${legacy.cardId}\0${legacy.createdAt}`).digest("hex").slice(0, 32)}`;
      const pinnedIdentity = {
        ...pinned,
        integrationId,
        repositoryPath: project.repository.path,
        worktreeRoot: project.repository.worktreeRoot,
        storageRoot: path.join(root, "state"),
      };
      const inspectionLease = {
        integrationId,
        instanceId: "inspection",
        token: "inspection",
        assertHeld() {},
      };
      const store = new RunStore(
        pinnedIdentity.storageRoot,
        attemptId,
        pinnedIdentity,
        inspectionLease,
      );
      const imported = store.read();
      expect(imported).not.toBeNull();
      expect(imported!.owner.generation).toBeGreaterThan(1);
      expect(imported!.owner.token).toMatch(/^[0-9a-f-]{36}$/u);
      const snapshotArtifact = imported!.artifacts.find(
        (item) =>
          item.mediaType ===
          "application/vnd.agent-orchestrator.legacy-snapshot+json",
      )!;
      const snapshot = JSON.parse(
        fs.readFileSync(snapshotArtifact.path, "utf8"),
      ) as { sources: { path: string; sha256: string; bytesBase64: string }[] };
      for (const source of snapshot.sources) {
        const bytes = Buffer.from(source.bytesBase64, "base64");
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          source.sha256,
        );
        expect(bytes).toEqual(originalSources.get(source.path));
      }
      const registry = new RunRegistry(
        pinnedIdentity.storageRoot,
        integrationId,
        inspectionLease,
      );
      expect(registry.read()).toMatchObject({
        attemptId,
        integrationId,
        generation: 1,
      });
      const markerId = createHash("sha256")
        .update(`${integrationId}:${attemptId}`)
        .digest("hex");
      const marker = JSON.parse(
        fs.readFileSync(
          path.join(
            pinnedIdentity.storageRoot,
            "migrations",
            `${markerId}.json`,
          ),
          "utf8",
        ),
      ) as { stage: string; manifestHash: string; attemptId: string };
      expect(marker).toMatchObject({
        stage: "complete",
        attemptId,
        manifestHash: imported!.legacy.sourceManifestHash,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  it("refuses symlinked marker directories without touching their targets", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "legacy-marker-symlink-"),
    );
    try {
      const storage = path.join(root, "state");
      const sourceBytes = Buffer.from(JSON.stringify(legacy));
      const sources = [
        {
          family: "task-executions",
          path: path.join(root, "original.json"),
          projectId: "project-one",
          cardId: "card-one",
          sha256: createHash("sha256").update(sourceBytes).digest("hex"),
          bytes: sourceBytes,
          parsed: legacy,
        },
      ];
      const candidate = buildLegacyRunSnapshot({
        rawTask: legacy,
        sources,
        pinned: { ...pinned, storageRoot: storage },
        lease,
      });
      const markerId = createHash("sha256")
        .update(`${lease.integrationId}:${candidate.record.attemptId}`)
        .digest("hex");
      const victim = path.join(root, "victim");
      fs.mkdirSync(victim);
      const target = path.join(victim, `${markerId}.json`);
      fs.writeFileSync(target, "preserve-me");
      fs.mkdirSync(storage, { recursive: true });
      fs.symlinkSync(victim, path.join(storage, "migrations"));
      const store = new RunStore(
        storage,
        candidate.record.attemptId,
        candidate.record.pinned,
        lease,
      );
      const registry = new RunRegistry(storage, lease.integrationId, lease);
      expect(() =>
        migrateLegacyAttempt({
          store,
          registry,
          lease,
          candidate,
          markerRoot: storage,
        }),
      ).toThrow(/Unsafe migration directory/);
      expect(fs.readFileSync(target, "utf8")).toBe("preserve-me");
      expect(registry.read()).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
