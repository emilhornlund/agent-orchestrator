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
