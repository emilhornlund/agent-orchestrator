import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import {
  beginPrimaryExecution,
  completePrimaryExecution,
  getCompletedPrimaryExecutionResult,
  PrimaryOperationBlockedError,
  reconcilePendingPrimaryExecution,
} from "../src/task-session/primary-operation-ledger.js";
import { registerProcessSecrets } from "../src/process/process-runtime.js";
import {
  parseTaskExecutionRecord,
  type TaskExecutionRecord,
} from "../src/task-session/task-execution-record.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "primary-ledger-"));
  roots.push(root);
  const project = {
    id: "project",
    repository: {
      path: path.join(root, "repo"),
      worktreeRoot: path.join(root, "worktrees"),
    },
  } as ProjectConfig;
  fs.mkdirSync(project.repository.path);
  fs.mkdirSync(project.repository.worktreeRoot);
  const store = new TaskExecutionStore(path.join(root, "state"), project);
  const now = new Date().toISOString();
  store.create({
    version: 1,
    projectId: "project",
    cardId: "card",
    phase: "planning",
    operationKey: "op",
    revision: 1,
    retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
    createdAt: now,
    updatedAt: now,
  });
  return { root, project, store };
}

describe("durable primary operation ledger", () => {
  it("persists the three-execution budget across store restart and session replacement", () => {
    const f = fixture();
    for (let n = 1; n <= 3; n++) {
      const store = new TaskExecutionStore(
        path.join(f.root, "state"),
        f.project,
      );
      beginPrimaryExecution(
        store,
        "card",
        "implementation",
        "implementation",
        `session-${n}`,
      );
      completePrimaryExecution(store, "card", "implementation", "failed", {
        exitCode: 1,
        output: "failure",
        errorOutput: "",
      });
      if (n < 3)
        reconcilePendingPrimaryExecution(
          store,
          "card",
          "implementation",
          "stopped",
        );
    }
    expect(() =>
      beginPrimaryExecution(
        new TaskExecutionStore(path.join(f.root, "state"), f.project),
        "card",
        "implementation",
        "implementation",
        "replacement-session",
      ),
    ).toThrow(PrimaryOperationBlockedError);
    expect(
      f.store.read("card")?.primaryOperations?.implementation,
    ).toMatchObject({ executions: 3, lastSessionId: "session-3" });
  });

  it("blocks unknown pending outcomes and completed operation replay", () => {
    const { store } = fixture();
    beginPrimaryExecution(store, "card", "op", "planning");
    reconcilePendingPrimaryExecution(store, "card", "op", "unknown");
    expect(() =>
      beginPrimaryExecution(store, "card", "op", "planning"),
    ).toThrow(PrimaryOperationBlockedError);
    reconcilePendingPrimaryExecution(store, "card", "op", "completed", {
      exitCode: 0,
      output: "ok",
      errorOutput: "",
    });
    expect(() =>
      beginPrimaryExecution(store, "card", "op", "planning"),
    ).toThrow(PrimaryOperationBlockedError);
  });

  it("does not let a reset correction counter bypass an ambiguous operation ID", () => {
    const { store } = fixture();
    beginPrimaryExecution(
      store,
      "card",
      "feedback-cycle:4:repair:1",
      "feedback-repair",
    );
    reconcilePendingPrimaryExecution(
      store,
      "card",
      "feedback-cycle:4:repair:1",
      "unknown",
    );

    // A later feedback cycle may restart its local pass counter at one. Its
    // distinct semantic ID must not dispatch while the old ID is unresolved.
    expect(() =>
      beginPrimaryExecution(
        store,
        "card",
        "feedback-cycle:5:repair:1",
        "feedback-repair",
      ),
    ).toThrow(PrimaryOperationBlockedError);
    expect(
      store.read("card")?.primaryOperations?.["feedback-cycle:5:repair:1"],
    ).toBeUndefined();
  });

  it("releases only a proven never-dispatched reservation", () => {
    const { store } = fixture();
    beginPrimaryExecution(store, "card", "op", "planning");
    reconcilePendingPrimaryExecution(store, "card", "op", "not-dispatched");
    expect(store.read("card")?.primaryOperations?.op?.executions).toBe(0);
    beginPrimaryExecution(store, "card", "op", "planning");
    completePrimaryExecution(store, "card", "op", "failed");
    expect(store.read("card")?.primaryOperations?.op?.executions).toBe(1);
  });

  it("rejects malformed ledger invariants and accepts legacy absence", () => {
    const { store } = fixture();
    const record = store.read("card") as TaskExecutionRecord;
    expect(parseTaskExecutionRecord(record).primaryOperations).toBeUndefined();
    const entry = {
      id: "other",
      activity: "work",
      executions: 0,
      status: "dispatched",
      updatedAt: record.updatedAt,
    } as const;
    expect(() =>
      parseTaskExecutionRecord({
        ...record,
        primaryOperations: { key: entry },
      }),
    ).toThrow();
    expect(() =>
      parseTaskExecutionRecord({
        ...record,
        primaryOperations: { other: { ...entry, id: "other", executions: 4 } },
      }),
    ).toThrow();
    expect(() =>
      parseTaskExecutionRecord({
        ...record,
        primaryOperations: {
          other: { ...entry, id: "other", status: "exhausted" },
        },
      }),
    ).toThrow();
  });

  it("requires stop proof before retry and atomically caches completed replay result", () => {
    const f = fixture();
    registerProcessSecrets(["token-secret"]);
    beginPrimaryExecution(
      f.store,
      "card",
      "work",
      "implementation",
      "session-a",
    );
    completePrimaryExecution(f.store, "card", "work", "failed");
    expect(() =>
      beginPrimaryExecution(f.store, "card", "work", "implementation"),
    ).toThrow(PrimaryOperationBlockedError);
    reconcilePendingPrimaryExecution(f.store, "card", "work", "stopped");
    beginPrimaryExecution(
      f.store,
      "card",
      "work",
      "implementation",
      "session-b",
    );
    completePrimaryExecution(f.store, "card", "work", "completed", {
      exitCode: 0,
      output: "token-secret",
      errorOutput: "",
      sessionId: "session-b",
    });
    const restarted = new TaskExecutionStore(
      path.join(f.root, "state"),
      f.project,
    );
    expect(
      getCompletedPrimaryExecutionResult(restarted, "card", "work"),
    ).toMatchObject({
      exitCode: 0,
      output: "[REDACTED]",
      sessionId: "session-b",
    });
    expect(() =>
      beginPrimaryExecution(restarted, "card", "work", "implementation"),
    ).toThrow(PrimaryOperationBlockedError);
  });

  it("records exhausted outcome and evidence on the third failed execution", () => {
    const { store } = fixture();
    for (let n = 1; n <= 3; n++) {
      beginPrimaryExecution(store, "card", "work", "implementation");
      completePrimaryExecution(store, "card", "work", "failed", {
        exitCode: 1,
        output: "",
        errorOutput: "stopped",
      });
      if (n < 3)
        reconcilePendingPrimaryExecution(store, "card", "work", "stopped");
    }
    expect(store.read("card")?.primaryOperations?.work).toMatchObject({
      status: "exhausted",
      executions: 3,
      diagnostic: "Execution budget exhausted",
      resultArtifact: { reference: expect.stringMatching(/^sha256:/u) },
    });
  });
});
