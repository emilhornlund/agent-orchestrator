import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { TaskMutationBlockStore } from "../src/orchestrator/task-mutation-block-store.js";
import { FeedbackLedgerStore } from "../src/task-session/feedback-ledger-store.js";
import { PrMaintenanceStore } from "../src/task-session/pr-maintenance-store.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import { runTaskSessionReviewWithRepairs } from "../src/task-session/run-task-session-review-repairs.js";
import { runTaskSessionValidationWithRepairs } from "../src/task-session/run-task-session-validation-repairs.js";
import { RunStore } from "../src/task-session/run-store.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
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
import {
  CommandRunner,
  type RunCommand,
} from "../src/process/command-runner.js";
import {
  OpenCodeClient,
  type RunOpenCode,
} from "../src/opencode/opencode-client.js";

let root: string;
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("lease-backed project store projections", () => {
  it("selects a review cycle budget atomically and preserves its bound on restart", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "review-budget-authority-"));
    const repository = path.join(root, "repository");
    const worktrees = path.join(root, "worktrees");
    const runtime = path.join(root, "runtime");
    fs.mkdirSync(repository);
    fs.mkdirSync(worktrees);
    const project = {
      id: "project-one",
      repository: { path: repository, worktreeRoot: worktrees },
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
      lifecycle: "review",
      checkpoint: "review",
      publicationState: "none",
      operation: { id: "cycle-two", kind: "review", generation: 1 },
      wait: { reason: null, dependency: null, since: null, retryAt: null },
      owner: {
        instanceId: lease.instanceId,
        token: lease.token,
        generation: 1,
      },
      resources: [],
      pendingOperations: [],
      queue: [],
      budgets: {
        review: {
          limit: 2,
          used: 0,
          episodeId: "card-one:initial-review",
          trigger: "initial-implementation",
        },
      },
      sessions: {},
      artifacts: [],
      expectedTrelloListId: "review",
      terminalSync: "not-applicable",
      terminalEvidence: null,
      legacy: {},
      compatibility: {},
      updatedAt: new Date().toISOString(),
    });
    const authority = new ProjectRunAuthority(project.id, envelopeStore, 1);
    const store = new TaskExecutionStore(runtime, project, authority);
    const ciReviewCycleId = "cycle-two:ci-review:cycle-two";
    const initial = {
      version: 1 as const,
      projectId: project.id,
      cardId: "card-one",
      phase: "review" as const,
      primarySessionId: "primary-session",
      sessionCreationStatus: "bound" as const,
      expectedBranch: "agent/card-one",
      operationKey: "cycle-two",
      revision: 1,
      retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
      createdAt: "2026-11-07T09:00:00.000Z",
      updatedAt: "2026-11-07T09:00:00.000Z",
    };
    authority.run(() => store.create(initial));
    let identity = `sha256:${"a".repeat(64)}`;
    let reviewCalls = 0;
    let repairCalls = 0;
    let qualityCalls = 0;
    const run = (maxAttempts: number) =>
      runTaskSessionReviewWithRepairs({
        store,
        maxAttempts,
        projectId: project.id,
        cardId: "card-one",
        operationKey: "cycle-two",
        reviewCycleId: ciReviewCycleId,
        expectedPrimarySessionId: "primary-session",
        runReview: async (previousFindings) => {
          reviewCalls += 1;
          return {
            review: {
              version: 1,
              projectId: project.id,
              cardId: "card-one",
              verdict: "fail" as const,
              requirementAssessments: [
                {
                  requirementId: "REQ-1",
                  status: "unsatisfied" as const,
                  details: "Missing",
                  evidence: [],
                },
              ],
              blockingFindings: previousFindings.length
                ? previousFindings.map(({ id, kind, summary, detail }) => ({
                    id,
                    kind,
                    summary,
                    detail,
                  }))
                : [
                    {
                      kind: "incomplete" as const,
                      summary: "Missing",
                      detail: "Fix requirement",
                    },
                  ],
              previousFindingAssessments: previousFindings.map(({ id }) => ({
                findingId: id,
                status: "unresolved" as const,
              })),
              reviewedContentIdentity: identity,
            },
            contentIdentity: identity,
          };
        },
        repair: async () => {
          repairCalls += 1;
          identity = `sha256:${String(repairCalls).padStart(64, "b")}`;
        },
        rerunQuality: async () => {
          qualityCalls += 1;
        },
        getCurrentContentIdentity: async () => identity,
      });

    const exhausted = await authority.run(() => run(3));
    expect(exhausted.record.reviewRepair).toMatchObject({
      cycleId: ciReviewCycleId,
      status: "exhausted",
      maxAttempts: 3,
    });
    expect(exhausted.record.retryCounters.review).toBe(3);
    expect({ reviewCalls, repairCalls, qualityCalls }).toEqual({
      reviewCalls: 4,
      repairCalls: 3,
      qualityCalls: 3,
    });
    expect(envelopeStore.read()?.budgets.review).toMatchObject({
      limit: 4,
      used: 3,
      episodeId: ciReviewCycleId,
    });

    // A compatible restart with a lower configured value keeps the selected
    // persisted cycle bound and recovers its durable final review without a
    // fourth repair or a counter reset.
    const restarted = await authority.run(() => run(1));
    expect(restarted.record.reviewRepair?.maxAttempts).toBe(3);
    expect(restarted.record.retryCounters.review).toBe(3);
    expect({ reviewCalls, repairCalls, qualityCalls }).toEqual({
      reviewCalls: 4,
      repairCalls: 3,
      qualityCalls: 3,
    });
    expect(envelopeStore.read()?.budgets.review).toMatchObject({
      limit: 4,
      used: 3,
      episodeId: ciReviewCycleId,
    });
  });

  it("reconciles a legacy canonical validation limit before charging a configured higher bound", async () => {
    root = fs.mkdtempSync(
      path.join(os.tmpdir(), "validation-budget-authority-"),
    );
    const repository = path.join(root, "repository");
    const worktrees = path.join(root, "worktrees");
    const runtime = path.join(root, "runtime");
    const worktree = path.join(worktrees, "card-one");
    fs.mkdirSync(repository);
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, "src.ts"), "initial\n");
    const project = {
      id: "project-one",
      opencode: { remediation: { validationMaxPasses: 4 } },
      repository: {
        path: repository,
        worktreeRoot: worktrees,
        validationCommand: "validate",
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
      instanceId: "validation-budget-owner",
      token: "validation-budget-token",
      assertHeld: vi.fn(),
    };
    const runStore = new RunStore(runtime, "attempt-validation", pinned, lease);
    const timestamp = new Date().toISOString();
    runStore.create({
      version: 1,
      revision: 1,
      projectId: project.id,
      cardId: "card-one",
      attemptId: "attempt-validation",
      taskKind: "implementation",
      pinned,
      lifecycle: "validation",
      checkpoint: "validation",
      publicationState: "none",
      operation: {
        id: "validation-operation",
        kind: "validation",
        generation: 1,
      },
      wait: { reason: null, dependency: null, since: null, retryAt: null },
      owner: {
        instanceId: lease.instanceId,
        token: lease.token,
        generation: 1,
      },
      resources: [],
      pendingOperations: [],
      queue: [],
      budgets: {
        validation: {
          limit: 2,
          used: 0,
          episodeId: "card-one:initial-validation",
          trigger: "initial-implementation",
        },
      },
      sessions: { primary: "session-one" },
      artifacts: [],
      expectedTrelloListId: "working",
      terminalSync: "not-applicable",
      terminalEvidence: null,
      legacy: {},
      compatibility: {},
      updatedAt: timestamp,
    });
    const authority = new ProjectRunAuthority(project.id, runStore, 1);
    const store = new TaskExecutionStore(runtime, project, authority);
    await authority.run(() =>
      store.create({
        version: 1,
        projectId: project.id,
        cardId: "card-one",
        phase: "validation",
        primarySessionId: "session-one",
        sessionCreationStatus: "bound",
        expectedBranch: "agent/card-one",
        operationKey: "validation-operation",
        validationRepair: {
          cycleId: "validation-operation",
          status: "active",
        },
        revision: 1,
        retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    const command = vi.fn<RunCommand>(async () => ({
      exitCode: 1,
      output: "validation still fails",
      errorOutput: "failing check",
    }));
    let repairNumber = 0;
    const runOpenCode = vi.fn<RunOpenCode>(async () => {
      repairNumber += 1;
      fs.writeFileSync(
        path.join(worktree, "src.ts"),
        `repair ${repairNumber}\n`,
      );
      return { exitCode: 0, output: "repair changed source", errorOutput: "" };
    });
    const git = {
      getCurrentBranch: vi.fn(async () => "agent/card-one"),
      getHeadSha: vi.fn(async () => "a".repeat(40)),
      getHeadTrackedFiles: vi.fn(async () => ["src.ts"]),
      getIndexEntries: vi.fn(
        async () =>
          "100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0\tsrc.ts\0",
      ),
      getUntrackedFiles: vi.fn(async () => []),
    } as never;
    const planStore = new TaskPlanStore(runtime, project, authority);

    const result = await runTaskSessionValidationWithRepairs({
      validation: {
        project,
        cardId: "card-one",
        expectedBranch: "agent/card-one",
        operationKey: "validation-operation",
        worktreePath: worktree,
        taskRecordStore: store,
        git,
        commands: new CommandRunner(command),
        signal: new AbortController().signal,
        timeoutMilliseconds: 60_000,
      },
      openCode: new OpenCodeClient(runOpenCode),
      planStore,
      card: {
        id: "card-one",
        name: "Task",
        desc: "Current task",
        idList: "working",
        idLabels: [],
        url: "https://trello.example/card-one",
      },
      expectedPrimarySessionId: "session-one",
      primaryOperationEvidence: { trustedRoot: runtime, cwd: worktree },
      repairRunOptions: {
        timeoutMilliseconds: 60_000,
        signal: new AbortController().signal,
      },
    });

    expect(result.attempts).toBe(4);
    expect(result.record.validationRepair).toMatchObject({
      maxAttempts: 4,
      status: "exhausted",
      stopReason: "attempt-limit",
    });
    expect(runStore.read()?.budgets.validation).toMatchObject({
      limit: 4,
      used: 4,
      episodeId: "validation-operation",
    });

    project.opencode.remediation.validationMaxPasses = 1;
    const resumed = await runTaskSessionValidationWithRepairs({
      validation: {
        project,
        cardId: "card-one",
        expectedBranch: "agent/card-one",
        operationKey: "validation-operation",
        worktreePath: worktree,
        taskRecordStore: store,
        git,
        commands: new CommandRunner(command),
        signal: new AbortController().signal,
        timeoutMilliseconds: 60_000,
      },
      openCode: new OpenCodeClient(runOpenCode),
      planStore,
      card: {
        id: "card-one",
        name: "Task",
        desc: "Current task",
        idList: "working",
        idLabels: [],
        url: "https://trello.example/card-one",
      },
      expectedPrimarySessionId: "session-one",
      primaryOperationEvidence: { trustedRoot: runtime, cwd: worktree },
      repairRunOptions: {
        timeoutMilliseconds: 60_000,
        signal: new AbortController().signal,
      },
    });

    expect(resumed.attempts).toBe(4);
    expect(runOpenCode).toHaveBeenCalledTimes(4);
    expect(command).toHaveBeenCalledTimes(5);
    expect(runStore.read()?.budgets.validation).toMatchObject({
      limit: 4,
      used: 4,
      episodeId: "validation-operation",
    });
  });

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
