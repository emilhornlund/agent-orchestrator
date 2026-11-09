import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { PrimaryOperationExhaustedError } from "../src/task-session/primary-operation-ledger.js";
import { PrimaryOperationWaitingError } from "../src/task-session/run-primary-operation.js";
import { PrimarySessionReconstructionRequiredError } from "../src/task-session/primary-task-session.js";
import { persistPrimaryOperationRecovery } from "../src/task-session/persist-primary-operation-recovery.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture(
  phase: "planning" | "implementation" | "ci" = "implementation",
  pullRequest = false,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "primary-recovery-"));
  roots.push(root);
  const project = {
    id: "p",
    repository: {
      path: path.join(root, "repo"),
      worktreeRoot: path.join(root, "wt"),
    },
  } as ProjectConfig;
  const store = new TaskExecutionStore(path.join(root, "state"), project);
  const now = new Date().toISOString();
  const record = store.create({
    version: 1,
    projectId: "p",
    cardId: "c",
    phase,
    operationKey: "attempt-key",
    primarySessionId: "session",
    expectedBranch: "agent/c",
    revision: 1,
    retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
    ...(pullRequest
      ? {
          pullRequest: {
            number: 7,
            url: "https://github.com/o/r/pull/7",
            headSha: "a".repeat(40),
          },
        }
      : {}),
    createdAt: now,
    updatedAt: now,
  });
  return { store, record };
}

describe("persistPrimaryOperationRecovery", () => {
  it("routes an exhausted three-execution pre-PR primary to pending terminal failure", () => {
    const { store, record } = fixture();
    const exhausted = store.compareAndSwap("c", record.revision, {
      ...record,
      primaryOperations: {
        op: {
          id: "op",
          activity: "implementation",
          executions: 3,
          status: "exhausted",
          retrySafe: true,
          diagnostic: "bounded primary executions exhausted",
          updatedAt: record.updatedAt,
        },
      },
      revision: 2,
    });
    expect(
      persistPrimaryOperationRecovery(
        store,
        exhausted,
        new PrimaryOperationExhaustedError("Primary operation op exhausted"),
        1000,
      ),
    ).toBe("prepublication-failure");
    const saved = store.read("c")!;
    expect(saved.phase).toBe("attention-required");
    expect(saved.terminalFailure?.outcome).toBe("pending");
    expect(saved.recoveryWait).toBeUndefined();
    expect(saved.revision).toBe(3);
  });

  it("routes three genuine reconstruction-ack failures through existing pre-PR terminal recovery", () => {
    const { store, record } = fixture();
    const exhausted = store.compareAndSwap("c", record.revision, {
      ...record,
      primaryOperations: {
        "attempt-key:reconstruction-ack:replacement": {
          id: "attempt-key:reconstruction-ack:replacement",
          activity: "reconstruction-acknowledgement",
          executions: 3,
          failureExecutions: 3,
          status: "exhausted",
          retrySafe: true,
          diagnostic: "read-only acknowledgement failed after verified stops",
          updatedAt: record.updatedAt,
        },
      },
      revision: record.revision + 1,
    });
    expect(
      persistPrimaryOperationRecovery(
        store,
        exhausted,
        new PrimaryOperationExhaustedError(
          "Primary operation attempt-key:reconstruction-ack:replacement exhausted",
        ),
        1_000,
      ),
    ).toBe("prepublication-failure");
    expect(store.read("c")).toMatchObject({
      phase: "attention-required",
      terminalFailure: { kind: "implementation", outcome: "pending" },
    });
  });

  it("keeps an open PR and ownership blocked after three genuine acknowledgement failures", () => {
    const { store, record } = fixture("ci", true);
    const operationId = "attempt-key:reconstruction-ack:replacement";
    const exhausted = store.compareAndSwap("c", record.revision, {
      ...record,
      primaryOperations: {
        [operationId]: {
          id: operationId,
          activity: "reconstruction-acknowledgement",
          executions: 3,
          failureExecutions: 3,
          status: "exhausted",
          retrySafe: true,
          diagnostic: "read-only acknowledgement failed after verified stops",
          updatedAt: record.updatedAt,
        },
      },
      revision: record.revision + 1,
    });
    expect(
      persistPrimaryOperationRecovery(
        store,
        exhausted,
        new PrimaryOperationExhaustedError(
          `Primary operation ${operationId} exhausted`,
        ),
        1_000,
      ),
    ).toBe("published-blockage");
    expect(store.read("c")).toMatchObject({
      phase: "ci",
      pullRequest: record.pullRequest,
      recoveryWait: { kind: "dependency" },
    });
    expect(store.read("c")?.terminalFailure).toBeUndefined();
  });

  it("retains published PR on waiting recovery", () => {
    const { store, record } = fixture("ci", true);
    expect(
      persistPrimaryOperationRecovery(
        store,
        record,
        new PrimaryOperationWaitingError("ci-op"),
        1000,
      ),
    ).toBe("waiting");
    const saved = store.read("c")!;
    expect(saved.phase).toBe("ci");
    expect(saved.pullRequest).toEqual(record.pullRequest);
    expect(saved.recoveryWait?.notificationId).toBe(
      "attempt-key/primary/ci-op",
    );
    expect(Date.parse(saved.recoveryWait!.retryAt)).toBeGreaterThan(Date.now());
  });

  it("paces a reconstruction acknowledgement outage without terminalizing", () => {
    const { store, record } = fixture();
    const operationId = "attempt-key:reconstruction-ack:replacement";
    const withOutage = store.compareAndSwap("c", record.revision, {
      ...record,
      primaryOperations: {
        [operationId]: {
          id: operationId,
          activity: "reconstruction-acknowledgement",
          executions: 1,
          dependencyOutages: 1,
          failureExecutions: 0,
          status: "failed",
          retrySafe: true,
          lastExecutionClassification: "dependency-outage",
          updatedAt: record.updatedAt,
        },
      },
      revision: record.revision + 1,
    });
    expect(
      persistPrimaryOperationRecovery(
        store,
        withOutage,
        new PrimaryOperationWaitingError(operationId),
        1_000,
      ),
    ).toBe("waiting");
    const waiting = store.read("c")!;
    expect(waiting.terminalFailure).toBeUndefined();
    expect(waiting.phase).toBe("implementation");
    expect(Date.parse(waiting.recoveryWait!.retryAt)).toBeGreaterThan(
      Date.now(),
    );
  });

  it("keeps the existing PR and ownership blocked after verified post-publication exhaustion", () => {
    const { store, record } = fixture("ci", true);
    const resultArtifact = store.writePrimaryResultArtifact("repair-result", {
      exitCode: 1,
      output: "failure",
      errorOutput: "bounded repair executions exhausted",
    });
    const exhausted = store.compareAndSwap("c", record.revision, {
      ...record,
      primaryOperations: {
        repair: {
          id: "repair",
          activity: "ci-correction",
          executions: 3,
          status: "exhausted",
          diagnostic: "bounded repair executions exhausted",
          resultArtifact,
          updatedAt: record.updatedAt,
        },
      },
      revision: record.revision + 1,
    });
    expect(
      persistPrimaryOperationRecovery(
        store,
        exhausted,
        new PrimaryOperationExhaustedError(
          "Primary operation repair exhausted",
        ),
        1000,
      ),
    ).toBe("published-blockage");
    expect(store.read("c")).toMatchObject({
      phase: "ci",
      pullRequest: record.pullRequest,
      recoveryWait: { kind: "dependency" },
    });
    expect(store.read("c")?.terminalFailure).toBeUndefined();
  });

  it("does not terminalize unknown exhaustion or advisory errors", () => {
    const f = fixture();
    expect(
      persistPrimaryOperationRecovery(
        f.store,
        f.record,
        new PrimaryOperationExhaustedError("Primary operation x exhausted"),
        1000,
      ),
    ).toBe("unhandled");
    expect(f.store.read("c")?.terminalFailure).toBeUndefined();
    expect(
      persistPrimaryOperationRecovery(
        f.store,
        f.record,
        new Error("advisory failed"),
        1000,
      ),
    ).toBe("unhandled");
  });

  it("accepts wrapped reconstruction requests and rejects invalid intervals", () => {
    const { store, record } = fixture("planning");
    const withOperation = store.compareAndSwap("c", record.revision, {
      ...record,
      primaryOperations: {
        rebuild: {
          id: "rebuild",
          activity: "reconstruction",
          executions: 1,
          status: "failed",
          retrySafe: true,
          updatedAt: record.updatedAt,
        },
      },
      revision: 2,
    });
    const wrapped = new Error("wrapper", {
      cause: new PrimarySessionReconstructionRequiredError(
        "details",
        "rebuild",
      ),
    });
    expect(
      persistPrimaryOperationRecovery(store, withOperation, wrapped, 1000),
    ).toBe("waiting");
    expect(() =>
      persistPrimaryOperationRecovery(store, store.read("c")!, wrapped, 0),
    ).toThrow(RangeError);
  });
});
