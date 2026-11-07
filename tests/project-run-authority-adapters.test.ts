import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { TaskMutationBlockStore } from "../src/orchestrator/task-mutation-block-store.js";
import { FeedbackLedgerStore } from "../src/task-session/feedback-ledger-store.js";
import { PrMaintenanceStore } from "../src/task-session/pr-maintenance-store.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import { RunStore } from "../src/task-session/run-store.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import { TaskPlanStore } from "../src/task-session/task-plan-store.js";
import {
  clearPendingCommitState,
  readPendingCommitState,
  readRejectedCommitState,
  readTrustedCommitState,
  writePendingCommitState,
  writeRejectedCommitState,
  writeTrustedCommitState,
} from "../src/orchestrator/trusted-commit-state.js";
import {
  clearPreparedConflict,
  readPreparedConflict,
  readPreparedConflicts,
  writePreparedConflict,
} from "../src/orchestrator/prepared-conflict-state.js";
import {
  loadReconciliationBlock,
  removeReconciliationBlock,
  writeReconciliationBlock,
} from "../src/orchestrator/reconciliation-block-storage.js";
import { cleanupPersistedStateTemporaryFiles } from "../src/orchestrator/persisted-state-temporary-files.js";

let root: string;
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("lease-backed project store projections", () => {
  it("routes queue, plan, feedback, maintenance, and blocker mutations only through the RunStore envelope", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "run-authority-adapters-"));
    const repository = path.join(root, "repository");
    const worktrees = path.join(root, "worktrees");
    const runtime = path.join(root, "runtime");
    fs.mkdirSync(repository);
    fs.mkdirSync(worktrees);
    const project = {
      id: "project-one",
      repository: {
        path: repository,
        worktreeRoot: worktrees,
        github: "owner/repository",
        defaultBranch: "main",
      },
    } as ProjectConfig;
    const integrationId = JSON.stringify({
      trelloBoardId: "board-one",
      githubRepository: "owner/repository",
    });
    const pinned = {
      integrationId,
      projectId: project.id,
      boardId: "board-one",
      lists: {
        ready: "ready",
        working: "working",
        review: "review",
        failed: "failed",
        done: "done",
        backlog: "backlog",
      },
      repository: "owner/repository",
      repositoryPath: repository,
      worktreeRoot: worktrees,
      storageRoot: runtime,
    };
    const lease = {
      integrationId,
      instanceId: "instance-one",
      token: "lease-token-one",
      assertHeld: vi.fn(),
    };
    const envelopeStore = new RunStore(runtime, "attempt-one", pinned, lease);
    envelopeStore.create({
      version: 1,
      revision: 1,
      projectId: project.id,
      cardId: "card-one",
      attemptId: "attempt-one",
      taskKind: "implementation",
      pinned,
      lifecycle: "planning",
      checkpoint: "planning",
      publicationState: "none",
      operation: { id: null, kind: null, generation: 0 },
      wait: { reason: null, dependency: null, since: null, retryAt: null },
      owner: {
        instanceId: lease.instanceId,
        token: lease.token,
        generation: 1,
      },
      resources: [],
      pendingOperations: [],
      queue: [],
      budgets: {},
      sessions: {},
      artifacts: [],
      expectedTrelloListId: null,
      terminalSync: "not-applicable",
      terminalEvidence: null,
      legacy: {},
      compatibility: {},
      updatedAt: new Date().toISOString(),
    });
    const authority = new ProjectRunAuthority(project.id, envelopeStore, 1);

    const legacyFiles = [
      path.join(runtime, "task-mutation-queues", `${project.id}.json`),
      path.join(runtime, "task-mutation-queues", `${project.id}.block.json`),
      path.join(runtime, "task-plans", project.id, "card-one.json"),
      path.join(runtime, "feedback-ledgers", project.id, "card-one.json"),
      path.join(runtime, "pr-maintenance", `${project.id}.json`),
    ];
    const legacySentinel =
      "preserve legacy bytes; authoritative adapter must not read or write this";
    for (const file of legacyFiles) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, legacySentinel);
    }

    authority.run(() => {
      const queue = new TaskMutationQueue(runtime, project);
      queue.enqueue({
        eventId: "event-one",
        projectId: project.id,
        cardId: "card-one",
        kind: "implementation",
        operationKey: "implementation-one",
        enqueuedAt: new Date().toISOString(),
      });
    });
    const plans = new TaskPlanStore(runtime, project, authority);
    plans.create(
      {
        version: 1,
        projectId: project.id,
        cardId: "card-one",
        requirements: [
          { id: "REQ-1", text: "Keep state", verification: "Test" },
        ],
        steps: [
          {
            id: "STEP-1",
            description: "Persist",
            requirementIds: ["REQ-1"],
            verification: "Run tests",
          },
        ],
        assumptions: [],
        blockers: [],
      },
      1,
    );
    const feedback = new FeedbackLedgerStore(runtime, project, authority);
    feedback.create("card-one", []);
    const maintenance = new PrMaintenanceStore(runtime, project, authority);
    maintenance.create({
      projectId: project.id,
      cardId: "card-one",
      pullRequest: {
        number: 7,
        url: "https://github.com/owner/repository/pull/7",
      },
      expectedRemoteHead: "a".repeat(40),
      targetBaseHead: "b".repeat(40),
      operationId: "maintenance-one",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const blocks = new TaskMutationBlockStore(runtime, project.id, authority);
    blocks.report("scope", "identity", "held for reconciliation");

    const projected = envelopeStore.read();
    expect(projected?.revision).toBe(6);
    expect(
      projected?.compatibility[ProjectRunAuthority.queueKey(project.id)],
    ).toBeDefined();
    expect(
      projected?.compatibility[
        ProjectRunAuthority.taskKey("task-plan", "card-one")
      ],
    ).toBeDefined();
    expect(
      projected?.compatibility[
        ProjectRunAuthority.taskKey("feedback-ledger", "card-one")
      ],
    ).toBeDefined();
    expect(
      projected?.compatibility[
        ProjectRunAuthority.taskKey("maintenance", project.id)
      ],
    ).toBeDefined();
    expect(
      projected?.compatibility[
        ProjectRunAuthority.mutationBlocksKey(project.id)
      ],
    ).toBeDefined();

    for (const legacyFile of legacyFiles) {
      expect(fs.readFileSync(legacyFile, "utf8")).toBe(legacySentinel);
      expect(fs.existsSync(`${legacyFile}.lock`)).toBe(false);
    }
    expect(lease.assertHeld).toHaveBeenCalled();

    const trusted = {
      version: 1 as const,
      kind: "trusted-commit" as const,
      projectId: project.id,
      cardId: "card-one",
      taskBranch: "agent/card-one",
      defaultBranch: "main",
      commitSha: "a".repeat(40),
    };
    const pending = {
      version: 1 as const,
      kind: "pending-commit" as const,
      projectId: project.id,
      cardId: "card-one",
      taskBranch: "agent/card-one",
      defaultBranch: "main",
      parentSha: "b".repeat(40),
    };
    const rejected = { ...trusted, kind: "rejected-commit" as const };
    const preparedPath = path.join(
      worktrees,
      ".orchestrator",
      "prepared-conflicts",
      project.id,
      "card-one.json",
    );
    const trustedPath = path.join(
      worktrees,
      ".orchestrator",
      "trusted-commits",
      project.id,
      "card-one.json",
    );
    const pendingPath = path.join(
      worktrees,
      ".orchestrator",
      "pending-commits",
      project.id,
      "card-one.json",
    );
    const rejectedPath = path.join(
      worktrees,
      ".orchestrator",
      "rejected-commits",
      project.id,
      "card-one.json",
    );
    const reconciliationPath = path.join(
      runtime,
      project.id,
      "reconciliation-block.json",
    );
    const stateSentinel = "legacy state must remain import evidence";
    for (const file of [
      preparedPath,
      trustedPath,
      pendingPath,
      rejectedPath,
      reconciliationPath,
    ]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, stateSentinel);
    }
    const originalTemporary = path.join(
      path.dirname(trustedPath),
      "card-one.json.999999999.tmp",
    );
    fs.writeFileSync(originalTemporary, stateSentinel);

    authority.run(() => {
      writeTrustedCommitState(project, "card-one", trusted);
      writePendingCommitState(project, "card-one", pending);
      writeRejectedCommitState(project, "card-one", rejected);
      expect(readTrustedCommitState(project, "card-one")).toEqual(trusted);
      expect(readPendingCommitState(project, "card-one")).toEqual(pending);
      expect(readRejectedCommitState(project, "card-one")).toEqual(rejected);
      clearPendingCommitState(project, "card-one");
      expect(readPendingCommitState(project, "card-one")).toBeNull();

      const prepared = writePreparedConflict(
        project,
        "card-one",
        ["src/file.ts"],
        {
          active: true,
          backend: "merge",
          headName: "agent/card-one",
          onto: "b".repeat(40),
          originalHead: "a".repeat(40),
        },
        {
          trustedTaskCommitSha: "a".repeat(40),
          rebaseTargetSha: "b".repeat(40),
        },
      );
      expect(readPreparedConflict(project, "card-one")).toEqual(prepared);
      expect(readPreparedConflicts(project)).toEqual([prepared]);
      clearPreparedConflict(project, "card-one");
      expect(readPreparedConflict(project, "card-one")).toBeNull();

      const block = {
        version: 1 as const,
        projectId: project.id,
        attemptKey: "card-one:operation",
        attempt: 3 as const,
        operation: "Trello card operation" as const,
        cardId: "card-one",
        reconciliationListId: "working",
        failureCategory: "Workflow" as const,
        failureReason: "temporary trouble",
        recoveryCondition: "card-moved-to-ready" as const,
        notificationIdentity: "notification-one",
        failureIdentity: "failure-one",
      };
      writeReconciliationBlock(runtime, block);
      expect(loadReconciliationBlock(runtime, project.id)).toEqual({
        status: "loaded",
        block,
      });
      removeReconciliationBlock(runtime, project.id);
      expect(loadReconciliationBlock(runtime, project.id)).toEqual({
        status: "missing",
      });
      cleanupPersistedStateTemporaryFiles([project], runtime);
      expect(fs.readFileSync(originalTemporary, "utf8")).toBe(stateSentinel);
    });
    for (const file of [
      preparedPath,
      trustedPath,
      pendingPath,
      rejectedPath,
      reconciliationPath,
    ])
      expect(fs.readFileSync(file, "utf8")).toBe(stateSentinel);
    expect(fs.readFileSync(originalTemporary, "utf8")).toBe(stateSentinel);

    const currentEnvelope = envelopeStore.read();
    if (!currentEnvelope) throw new Error("Expected durable attempt envelope");
    envelopeStore.mutateCompatibility({
      expectedRevision: currentEnvelope.revision,
      expectedOwnerGeneration: 1,
      key: ProjectRunAuthority.commitKey("trusted-commit", "card-one"),
      current: () => ({ value: { malformed: true }, result: undefined }),
      validate: (value) => value,
    });
    expect(() =>
      authority.run(() => readTrustedCommitState(project, "card-one")),
    ).toThrow();
  });
});
