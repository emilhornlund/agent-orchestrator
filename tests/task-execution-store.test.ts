import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import {
  TaskExecutionRecordConflictError,
  TaskExecutionStore,
} from "../src/task-session/task-execution-store.js";
import type { TaskExecutionRecord } from "../src/task-session/task-execution-record.js";
import type { TaskExecutionEvent } from "../src/task-session/task-execution-transition.js";
import { transitionTaskExecutionRecord } from "../src/task-session/task-execution-transition.js";
import { RunStore } from "../src/task-session/run-store.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";

let temporaryRoot: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();

  if (temporaryRoot !== undefined) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

function createFixture(): {
  project: ProjectConfig;
  storageRoot: string;
  store: TaskExecutionStore;
} {
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-task-store-"),
  );
  const project = {
    id: "project-one",
    repository: {
      path: path.join(temporaryRoot, "repository"),
      worktreeRoot: path.join(temporaryRoot, "worktrees"),
    },
  } as ProjectConfig;
  const storageRoot = path.join(temporaryRoot, "runtime-state");

  fs.mkdirSync(project.repository.path);
  fs.mkdirSync(project.repository.worktreeRoot);

  return {
    project,
    storageRoot,
    store: new TaskExecutionStore(storageRoot, project),
  };
}

function createRecord(
  overrides: Partial<TaskExecutionRecord> = {},
): TaskExecutionRecord {
  return {
    version: 1,
    projectId: "project-one",
    cardId: "card-one",
    phase: "planning",
    operationKey: "initial-plan-1",
    revision: 1,
    retryCounters: {
      validation: 0,
      review: 0,
      ci: 0,
      humanFeedback: 0,
    },
    createdAt: "2026-10-24T09:00:00.000Z",
    updatedAt: "2026-10-24T09:00:00.000Z",
    ...overrides,
  };
}

describe("TaskExecutionStore", () => {
  it("projects task record writes into the fenced attempt envelope without legacy files", () => {
    const { project, storageRoot } = createFixture();
    const integrationId = JSON.stringify({
      trelloBoardId: "board",
      githubRepository: "owner/repository",
    });
    const lease = {
      integrationId,
      instanceId: "instance-one",
      token: "lease-token-one",
      assertHeld: vi.fn(),
    };
    const pinned = {
      integrationId,
      projectId: project.id,
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
      repositoryPath: project.repository.path,
      worktreeRoot: project.repository.worktreeRoot,
      storageRoot,
    };
    const runStore = new RunStore(storageRoot, "attempt-one", pinned, lease);
    runStore.create({
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
    const authority = new ProjectRunAuthority(project.id, runStore, 1);
    const store = new TaskExecutionStore(storageRoot, project, authority);
    const record = createRecord();
    expect(store.create(record)).toEqual(record);
    expect(store.read(record.cardId)).toEqual(record);
    expect(runStore.read()?.revision).toBe(2);
    expect(
      fs.existsSync(
        path.join(
          storageRoot,
          "task-executions",
          project.id,
          `${record.cardId}.json`,
        ),
      ),
    ).toBe(false);
    const next = {
      ...record,
      revision: 2,
      phase: "implementation" as const,
      primarySessionId: "session-one",
      expectedBranch: "agent/card-one",
      lastEvent: {
        id: "initial-plan-1:plan-approved",
        type: "plan-approved" as const,
        operationKey: "initial-plan-1",
        occurredAt: "2026-10-24T09:00:00.000Z",
      },
    };
    store.compareAndSwap(record.cardId, 1, next);
    expect(store.read(record.cardId)).toEqual(next);
    expect(runStore.read()?.revision).toBe(3);
    expect(runStore.read()).toMatchObject({
      lifecycle: "implementation",
      sessions: { primary: "session-one" },
      operation: { id: "initial-plan-1", kind: "implementation" },
    });
    let projected: TaskExecutionRecord = next;
    for (const phase of [
      "validation",
      "review",
      "publication",
      "ci",
    ] as const) {
      const phaseEvent: Record<
        "validation" | "review" | "publication" | "ci",
        TaskExecutionEvent["type"]
      > = {
        validation: "implementation-completed",
        review: "validation-passed",
        publication: "review-passed",
        ci: "publication-completed",
      };
      const eventType = phaseEvent[phase];
      const occurredAt = new Date().toISOString();
      const following = {
        ...projected,
        phase,
        revision: projected.revision + 1,
        lastEvent: {
          id: `${projected.operationKey}:${eventType}:${projected.revision}`,
          type: eventType,
          operationKey: projected.operationKey,
          occurredAt,
          ...(phase === "ci"
            ? {
                pullRequest: {
                  number: 17,
                  url: "https://github.com/owner/repository/pull/17",
                  headSha: "a".repeat(40),
                },
              }
            : {}),
        },
        ...(phase === "publication" || phase === "ci"
          ? {
              pullRequest: {
                number: 17,
                url: "https://github.com/owner/repository/pull/17",
                headSha: "a".repeat(40),
              },
            }
          : {}),
      };
      store.compareAndSwap(record.cardId, projected.revision, following);
      projected = following;
      expect(runStore.read()?.lifecycle).toBe(phase);
    }
    expect(runStore.read()).toMatchObject({
      publicationState: "open",
      expectedTrelloListId: "review",
      resources: [
        expect.objectContaining({
          kind: "pull-request",
          id: "17",
          path: "https://github.com/owner/repository/pull/17",
        }),
      ],
    });
    const falseFailure: TaskExecutionRecord = {
      ...projected,
      phase: "attention-required",
      terminalFailure: {
        kind: "implementation",
        reason: "failure while PR remains open",
        outcome: "confirmed",
      },
      revision: projected.revision + 1,
    };
    expect(() =>
      store.compareAndSwap(record.cardId, projected.revision, falseFailure, {
        event: "failed",
        evidence: {
          prOutcome: "no-pr-failure",
          prObservationId: "no-pull-request:initial-plan-1",
          prVerifiedAt: new Date().toISOString(),
          trelloListId: pinned.lists.failed,
          trelloObservationId: "trello-failed-readback",
          trelloVerifiedAt: new Date().toISOString(),
        },
      }),
    ).toThrow("confirmed no-PR implementation failure");
    const advance = (type: TaskExecutionEvent["type"]) => {
      const occurredAt = new Date(
        Math.max(Date.now(), Date.parse(projected.updatedAt) + 1),
      ).toISOString();
      const event = {
        type,
        eventId: `${projected.operationKey}:${type}:${projected.revision}`,
        projectId: projected.projectId,
        cardId: projected.cardId,
        operationKey: projected.operationKey,
        occurredAt,
        ...(type === "publication-completed"
          ? {
              pullRequest: {
                number: 17,
                url: "https://github.com/owner/repository/pull/17",
                headSha: "a".repeat(40),
              },
            }
          : {}),
      } as TaskExecutionEvent;
      const nextRecord = transitionTaskExecutionRecord(projected, event);
      store.compareAndSwap(record.cardId, projected.revision, nextRecord);
      projected = nextRecord;
      return nextRecord;
    };
    advance("ci-passed-awaiting-human");
    expect(runStore.read()?.lifecycle).toBe("human-review");
    advance("feedback-received");
    expect(runStore.read()?.lifecycle).toBe("implementation");
    advance("implementation-completed");
    advance("validation-failed");
    expect(runStore.read()?.lifecycle).toBe("implementation");
    advance("implementation-completed");
    advance("validation-passed");
    advance("review-failed");
    expect(runStore.read()?.lifecycle).toBe("implementation");
    advance("implementation-completed");
    advance("validation-passed");
    advance("review-passed");
    advance("publication-completed");
    advance("ci-passed-awaiting-human");
    advance("feedback-ci-failed");
    expect(runStore.read()?.lifecycle).toBe("ci");
    advance("ci-passed-awaiting-human");
    advance("feedback-replies-published");
    expect(runStore.read()?.lifecycle).toBe("ci");
    advance("ci-passed-awaiting-human");
    advance("feedback-received");
    advance("implementation-completed");
    advance("validation-passed");
    advance("review-passed");
    advance("publication-completed");
    advance("ci-passed-awaiting-human");
    const doneProjection: TaskExecutionRecord = {
      ...projected,
      phase: "done",
      revision: projected.revision + 1,
    };
    const beforeTerminal = runStore.read()!;
    const terminalEvidence = {
      prOutcome: "merged" as const,
      prObservationId: "github-merged:17:sha",
      prVerifiedAt: new Date().toISOString(),
      trelloListId: pinned.lists.done,
      trelloObservationId: "trello-done-readback",
      trelloVerifiedAt: new Date().toISOString(),
    };
    store.compareAndSwap(record.cardId, projected.revision, doneProjection, {
      event: "merged",
      evidence: terminalEvidence,
    });
    const afterTerminal = runStore.read()!;
    expect(afterTerminal.revision).toBe(beforeTerminal.revision + 1);
    expect(afterTerminal).toMatchObject({
      lifecycle: "done",
      publicationState: "merged",
      terminalSync: "verified",
      terminalEvidence,
      compatibility: {
        "task-execution-card-one": expect.objectContaining({ phase: "done" }),
      },
    });
    const fencedStore = new TaskExecutionStore(
      storageRoot,
      project,
      new ProjectRunAuthority(project.id, runStore, 2),
    );
    expect(() => fencedStore.read(record.cardId)).toThrow(
      "Stale compatibility projection owner fence",
    );
  });

  it("creates and reads a validated record outside repository worktrees", () => {
    const { store, storageRoot, project } = createFixture();
    const record = createRecord();

    expect(store.create(record)).toEqual(record);
    expect(store.read(record.cardId)).toEqual(record);

    const filePath = path.join(
      storageRoot,
      "task-executions",
      project.id,
      `${record.cardId}.json`,
    );
    expect(fs.existsSync(filePath)).toBe(true);
    expect(
      fs.existsSync(path.join(project.repository.path, ".orchestrator")),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(project.repository.worktreeRoot, ".orchestrator"),
      ),
    ).toBe(false);
    expect(store.read("missing-card")).toBeNull();
  });

  it("persists unavailable AI review provenance across a publication restart", () => {
    const { store, storageRoot, project } = createFixture();
    const marker = {
      contentIdentity: `sha256:${"a".repeat(64)}`,
      diagnostic: "Independent implementation review exited with code 1",
    };
    const record = createRecord({
      phase: "publication",
      primarySessionId: "ses-1",
      sessionCreationStatus: "bound",
      expectedBranch: "agent/card-one",
      validationRepair: {
        cycleId: "initial-plan-1",
        status: "passed",
        evidence: {
          command: "yarn validate",
          startedAt: "2026-10-24T09:00:00.000Z",
          completedAt: "2026-10-24T09:01:00.000Z",
          exitCode: 0,
          diagnostic: "passed",
          contentIdentity: marker.contentIdentity,
        },
      },
      reviewUnavailable: marker,
    });
    store.create(record);
    const reloaded = new TaskExecutionStore(storageRoot, project);
    expect(reloaded.read("card-one")?.reviewUnavailable).toEqual(marker);
    expect(reloaded.read("card-one")?.phase).toBe("publication");
  });

  it("persists a consumed feedback recovery attempt across a worker restart", () => {
    const { store, storageRoot, project } = createFixture();
    const headSha = "a".repeat(40);
    const eventId = "feedback:head:round";
    const record = createRecord({
      phase: "review",
      primarySessionId: "session-1",
      sessionCreationStatus: "bound",
      expectedBranch: "agent/card-one",
      pullRequest: {
        number: 194,
        url: "https://github.com/owner/repo/pull/194",
        headSha,
      },
      feedbackRemediation: {
        operationId: eventId,
        status: "changed",
        headSha,
        ledgerRevision: 1,
      },
      reviewRepair: {
        cycleId: "initial-plan-1",
        status: "exhausted",
        maxAttempts: 1,
        finalReview: {
          version: 1,
          projectId: "project-one",
          cardId: "card-one",
          verdict: "fail",
          requirementAssessments: [
            {
              requirementId: "REQ-1",
              status: "unsatisfied",
              details: "Human review required",
              evidence: [],
            },
          ],
          blockingFindings: [
            { kind: "defect", summary: "Unresolved", detail: "Needs review" },
          ],
          reviewedContentIdentity: `sha256:${"b".repeat(64)}`,
        },
      },
      retryCounters: { validation: 0, review: 1, ci: 0, humanFeedback: 0 },
    });
    store.create(record);
    store.compareAndSwap(record.cardId, record.revision, {
      ...record,
      feedbackRecoveryAttemptEventId: eventId,
      revision: record.revision + 1,
      updatedAt: "2026-10-24T09:00:01.000Z",
    });
    const restarted = new TaskExecutionStore(storageRoot, project);
    expect(restarted.read(record.cardId)?.feedbackRecoveryAttemptEventId).toBe(
      eventId,
    );
  });

  it("claims each Human Review notification commit only once across store reloads", () => {
    const { store } = createFixture();
    store.create(createRecord());

    expect(store.claimHumanReviewNotification("card-one", "a".repeat(40))).toBe(
      true,
    );
    const reloadedStore = new TaskExecutionStore(
      path.join(temporaryRoot!, "runtime-state"),
      {
        id: "project-one",
        repository: {
          path: path.join(temporaryRoot!, "repository"),
          worktreeRoot: path.join(temporaryRoot!, "worktrees"),
        },
      } as ProjectConfig,
    );
    expect(
      reloadedStore.claimHumanReviewNotification("card-one", "a".repeat(40)),
    ).toBe(false);
    expect(
      reloadedStore.claimHumanReviewNotification("card-one", "b".repeat(40)),
    ).toBe(true);
  });

  it("rejects duplicate creation and stale compare-and-swap revisions", () => {
    const { store } = createFixture();
    const original = createRecord();
    store.create(original);

    expect(() => store.create(original)).toThrow(
      TaskExecutionRecordConflictError,
    );

    const updated = createRecord({
      revision: 2,
      operationKey: "implementation-1",
      phase: "planning",
      updatedAt: "2026-10-24T09:01:00.000Z",
    });
    expect(store.compareAndSwap(original.cardId, 1, updated)).toEqual(updated);
    expect(() => store.compareAndSwap(original.cardId, 1, updated)).toThrow(
      TaskExecutionRecordConflictError,
    );
    expect(store.read(original.cardId)).toEqual(updated);
  });

  it("preserves malformed authoritative data instead of overwriting it", () => {
    const { store, storageRoot, project } = createFixture();
    store.create(createRecord());
    const filePath = path.join(
      storageRoot,
      "task-executions",
      project.id,
      "card-one.json",
    );
    fs.writeFileSync(filePath, "{malformed", "utf8");

    expect(() => store.read("card-one")).toThrow(
      "Could not parse task execution record",
    );
    expect(() => store.create(createRecord())).toThrow(
      "Could not parse task execution record",
    );
    expect(fs.readFileSync(filePath, "utf8")).toBe("{malformed");
  });

  it("rejects traversal and storage roots overlapping repositories", () => {
    const { store, project, storageRoot } = createFixture();

    expect(() => store.read("../card-one")).toThrow("Invalid card ID");
    expect(
      () => new TaskExecutionStore(project.repository.path, project),
    ).toThrow("must not overlap");
    expect(
      () =>
        new TaskExecutionStore(
          path.join(project.repository.worktreeRoot, "runtime-state"),
          project,
        ),
    ).toThrow("must not overlap");
    expect(() => new TaskExecutionStore(temporaryRoot!, project)).toThrow(
      "must not overlap",
    );
    expect(() => new TaskExecutionStore("relative-state", project)).toThrow(
      "absolute path",
    );
    expect(storageRoot).not.toBe(project.repository.path);
  });

  it("retains the previous record and removes its temporary file on write failure", () => {
    const { store, storageRoot, project } = createFixture();
    const original = createRecord();
    store.create(original);
    const updated = createRecord({
      revision: 2,
      operationKey: "implementation-1",
      updatedAt: "2026-10-24T09:01:00.000Z",
    });
    const fsync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw new Error("simulated disk write failure");
    });

    expect(() => store.compareAndSwap(original.cardId, 1, updated)).toThrow(
      "simulated disk write failure",
    );
    fsync.mockRestore();

    expect(store.read(original.cardId)).toEqual(original);
    const recordDirectory = path.join(
      storageRoot,
      "task-executions",
      project.id,
    );
    expect(fs.readdirSync(recordDirectory)).toEqual(["card-one.json"]);
  });

  it("enforces the serialized record size limit before publishing", () => {
    const { store, storageRoot, project } = createFixture();
    const oversized = createRecord({ operationKey: "x".repeat(1024 * 1024) });

    expect(() => store.create(oversized)).toThrow("exceeds the");
    expect(
      fs.existsSync(
        path.join(storageRoot, "task-executions", project.id, "card-one.json"),
      ),
    ).toBe(false);
  });
});
