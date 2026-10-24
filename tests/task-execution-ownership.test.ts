import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import {
  TaskExecutionOwnershipError,
  loadOwnedTaskExecutionRecord,
} from "../src/task-session/task-execution-ownership.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import type { TaskExecutionRecord } from "../src/task-session/task-execution-record.js";

let temporaryRoot: string | undefined;

afterEach(() => {
  if (temporaryRoot !== undefined) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

function createFixture(): {
  record: TaskExecutionRecord;
  recordPath: string;
  store: TaskExecutionStore;
} {
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-task-ownership-"),
  );
  const project = {
    id: "project-one",
    repository: {
      path: path.join(temporaryRoot, "repository"),
      worktreeRoot: path.join(temporaryRoot, "worktrees"),
    },
  } as ProjectConfig;
  fs.mkdirSync(project.repository.path);
  fs.mkdirSync(project.repository.worktreeRoot);

  const store = new TaskExecutionStore(
    path.join(temporaryRoot, "runtime-state"),
    project,
  );
  const record: TaskExecutionRecord = {
    version: 1,
    projectId: project.id,
    cardId: "card-one",
    phase: "implementation",
    primarySessionId: "session-one",
    expectedBranch: "agent/card-one",
    operationKey: "operation-one",
    revision: 1,
    retryCounters: {
      validation: 0,
      review: 0,
      ci: 0,
      humanFeedback: 0,
    },
    createdAt: "2026-10-24T09:00:00.000Z",
    updatedAt: "2026-10-24T09:00:00.000Z",
  };
  store.create(record);

  return {
    record,
    recordPath: path.join(
      temporaryRoot,
      "runtime-state",
      "task-executions",
      project.id,
      `${record.cardId}.json`,
    ),
    store,
  };
}

function request(
  overrides: Partial<{
    projectId: string;
    cardId: string;
    expectedBranch: string;
    operationKey: string;
  }> = {},
) {
  return {
    projectId: "project-one",
    cardId: "card-one",
    expectedBranch: "agent/card-one",
    operationKey: "operation-one",
    ...overrides,
  };
}

describe("loadOwnedTaskExecutionRecord", () => {
  it("returns a record when project, card, branch, and operation match", () => {
    const { record, store } = createFixture();

    expect(loadOwnedTaskExecutionRecord(store, request())).toEqual(record);
  });

  it("refuses a record stored under the requested card with another card owner", () => {
    const { record, recordPath, store } = createFixture();
    const wrongOwner = { ...record, cardId: "other-card" };
    fs.writeFileSync(recordPath, JSON.stringify(wrongOwner), "utf8");
    const before = fs.readFileSync(recordPath, "utf8");

    expect(() => loadOwnedTaskExecutionRecord(store, request())).toThrow(
      "ownership does not match",
    );
    expect(fs.readFileSync(recordPath, "utf8")).toBe(before);
  });

  it("refuses an operation with a stale operation identity without mutation", () => {
    const { recordPath, store } = createFixture();
    const before = fs.readFileSync(recordPath, "utf8");

    expect(() =>
      loadOwnedTaskExecutionRecord(
        store,
        request({ operationKey: "operation-two" }),
      ),
    ).toThrow(TaskExecutionOwnershipError);
    expect(fs.readFileSync(recordPath, "utf8")).toBe(before);
  });

  it("refuses a mismatched branch without mutation", () => {
    const { recordPath, store } = createFixture();
    const before = fs.readFileSync(recordPath, "utf8");

    expect(() =>
      loadOwnedTaskExecutionRecord(
        store,
        request({ expectedBranch: "agent/other-card" }),
      ),
    ).toThrow("branch does not match");
    expect(fs.readFileSync(recordPath, "utf8")).toBe(before);
  });

  it("refuses a missing task record without mutation", () => {
    const { recordPath, store } = createFixture();
    const before = fs.readFileSync(recordPath, "utf8");

    expect(() =>
      loadOwnedTaskExecutionRecord(store, request({ cardId: "missing-card" })),
    ).toThrow("No task execution record exists");
    expect(fs.readFileSync(recordPath, "utf8")).toBe(before);
  });

  it("refuses project identity mismatches without mutation", () => {
    const { recordPath, store } = createFixture();
    const before = fs.readFileSync(recordPath, "utf8");

    expect(() =>
      loadOwnedTaskExecutionRecord(
        store,
        request({ projectId: "project-two" }),
      ),
    ).toThrow("owner does not match");
    expect(fs.readFileSync(recordPath, "utf8")).toBe(before);
  });
});
