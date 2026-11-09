import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import {
  OpenCodeRunAbortedError,
  OpenCodeTimeoutError,
  type OpenCodeRunResult,
} from "../src/opencode/opencode-client.js";
import { registerProcessSecrets } from "../src/process/process-runtime.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import {
  runPrimaryOperation,
  PrimaryOperationWaitingError,
  type PrimaryOperationEntry,
} from "../src/task-session/run-primary-operation.js";
import {
  beginPrimaryExecution,
  bindPrimaryExecutionEvidence,
  completePrimaryExecution,
  PrimaryOperationExhaustedError,
  reconcilePendingPrimaryExecution,
} from "../src/task-session/primary-operation-ledger.js";
import { createHash } from "node:crypto";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-primary-"));
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
  fs.mkdirSync(path.join(root, "state"));
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
const success: OpenCodeRunResult = {
  exitCode: 0,
  output: "ok",
  errorOutput: "",
};
const failure: OpenCodeRunResult = {
  exitCode: 1,
  output: "bad",
  errorOutput: "bad",
};
const stopped = (e: PrimaryOperationEntry) => ({
  status: "stopped-after-dispatch" as const,
  operationId: "op",
  execution: e.executions,
  ...(e.lastSessionId === undefined ? {} : { sessionId: e.lastSessionId }),
});
const options = (
  store: TaskExecutionStore,
  execute: () => Promise<OpenCodeRunResult>,
  inspectPending: (entry: PrimaryOperationEntry) => Promise<
    | { status: "never-dispatched" }
    | {
        status: "stopped-after-dispatch";
        operationId: string;
        execution: number;
        sessionId?: string;
        failureClassification?: "dependency-outage";
      }
    | { status: "running" }
    | { status: "unknown" }
    | { status: "completed"; result: OpenCodeRunResult }
  >,
) => ({
  store,
  cardId: "card",
  operationId: "op",
  activity: "work",
  sessionId: "session",
  execute,
  inspectPending,
});

describe("runPrimaryOperation", () => {
  it("does not mark outage advice safe to skip until the final dispatch has authoritative stop proof", async () => {
    const f = fixture();
    const outage: OpenCodeRunResult = {
      exitCode: 1,
      output: "provider unavailable",
      errorOutput: "provider unavailable",
      failureClassification: "dependency-outage",
    };
    let inspection: "stopped" | "unknown" = "stopped";
    const inspectPending = vi.fn(async (entry: PrimaryOperationEntry) =>
      inspection === "unknown"
        ? { status: "unknown" as const }
        : {
            status: "stopped-after-dispatch" as const,
            operationId: entry.id,
            execution: entry.executions,
            ...(entry.lastSessionId === undefined
              ? {}
              : { sessionId: entry.lastSessionId }),
            failureClassification: "dependency-outage" as const,
          },
    );
    const execute = vi.fn(async () => outage);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        runPrimaryOperation(options(f.store, execute, inspectPending)),
      ).rejects.toBeInstanceOf(PrimaryOperationWaitingError);
    }
    expect(f.store.read("card")?.primaryOperations?.op).toMatchObject({
      status: "failed",
      dependencyOutages: 2,
      retrySafe: true,
    });

    inspection = "unknown";
    await expect(
      runPrimaryOperation(options(f.store, execute, inspectPending)),
    ).rejects.toBeInstanceOf(PrimaryOperationWaitingError);
    const uncertain = f.store.read("card")?.primaryOperations?.op;
    expect(uncertain).toMatchObject({
      status: "failed",
      dependencyOutages: 3,
    });
    expect(uncertain?.retrySafe).toBeUndefined();

    inspection = "stopped";
    await expect(
      runPrimaryOperation(options(f.store, execute, inspectPending)),
    ).rejects.toBeInstanceOf(PrimaryOperationWaitingError);
    expect(f.store.read("card")?.primaryOperations?.op).toMatchObject({
      status: "failed",
      dependencyOutages: 3,
      retrySafe: true,
      accountedExecution: 3,
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("continues meaningful bounded operations despite a persisted task age of several days", async () => {
    const f = fixture();
    const createdAt = "2020-01-01T00:00:00.000Z";
    const current = f.store.read("card");
    if (current === null) throw new Error("Expected task record");
    f.store.compareAndSwap("card", current.revision, {
      ...current,
      createdAt,
      revision: current.revision + 1,
    });
    const inspectPending = vi.fn(async () => ({
      status: "never-dispatched" as const,
    }));
    const first = vi.fn(async () => success);
    const second = vi.fn(async () => success);

    await runPrimaryOperation(options(f.store, first, inspectPending));
    const next = f.store.read("card");
    if (next === null) throw new Error("Expected persisted task record");
    const nextOptions = {
      ...options(f.store, second, inspectPending),
      operationId: "op:continued",
    };
    await runPrimaryOperation(nextOptions);

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(f.store.read("card")?.createdAt).toBe(createdAt);
    expect(
      f.store.read("card")?.primaryOperations?.["op:continued"]?.status,
    ).toBe("completed");
  });

  it("continues an exactly authorized stopped operation without repeating inspection or resetting its execution count", async () => {
    const f = fixture();
    beginPrimaryExecution(f.store, "card", "op", "work", "session");
    reconcilePendingPrimaryExecution(f.store, "card", "op", "stopped");
    const execute = vi.fn(async () => success);
    const inspectPending = vi.fn(async () => ({ status: "unknown" as const }));

    await expect(
      runPrimaryOperation({
        ...options(f.store, execute, inspectPending),
        operationId: "op",
        activity: "work",
      }),
    ).resolves.toEqual(success);

    expect(inspectPending).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(f.store.read("card")?.primaryOperations?.op).toMatchObject({
      id: "op",
      activity: "work",
      executions: 2,
      status: "completed",
    });
  });

  it("retries only proven stopped failures, persists result and replays after restart", async () => {
    const f = fixture();
    const execute = vi
      .fn()
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce(success);
    const inspect = vi.fn(async (e: PrimaryOperationEntry) => stopped(e));
    expect(
      await runPrimaryOperation(options(f.store, execute, inspect)),
    ).toMatchObject(success);
    const restarted = new TaskExecutionStore(
      path.join(f.root, "state"),
      f.project,
    );
    expect(
      await runPrimaryOperation(
        options(
          restarted,
          vi.fn(),
          vi.fn(async () => ({ status: "unknown" as const })),
        ),
      ),
    ).toMatchObject(success);
    expect(execute).toHaveBeenCalledTimes(3);
  });
  it("inspects failed prior entry before restart dispatch and blocks unknown/running", async () => {
    const f = fixture();
    const execute = vi.fn().mockResolvedValue(failure);
    await expect(
      runPrimaryOperation(
        options(f.store, execute, async () => ({ status: "unknown" }) as const),
      ),
    ).rejects.toBeInstanceOf(PrimaryOperationWaitingError);
    const next = new TaskExecutionStore(path.join(f.root, "state"), f.project);
    const replacement = vi.fn().mockResolvedValue(success);
    await expect(
      runPrimaryOperation(
        options(
          next,
          replacement,
          async () => ({ status: "running" }) as const,
        ),
      ),
    ).rejects.toBeInstanceOf(PrimaryOperationWaitingError);
    expect(replacement).not.toHaveBeenCalled();
  });
  it("persists third failure as exhausted and replays that state", async () => {
    const f = fixture();
    const execute = vi.fn().mockResolvedValue(failure);
    const inspect = vi.fn(async (e: PrimaryOperationEntry) => stopped(e));
    await expect(
      runPrimaryOperation(options(f.store, execute, inspect)),
    ).rejects.toBeInstanceOf(PrimaryOperationExhaustedError);
    const again = new TaskExecutionStore(path.join(f.root, "state"), f.project);
    await expect(
      runPrimaryOperation(options(again, vi.fn(), vi.fn())),
    ).rejects.toBeInstanceOf(PrimaryOperationExhaustedError);
    expect(execute).toHaveBeenCalledTimes(3);
  });
  it("paces recognized provider outages across restarts without consuming the crash budget", async () => {
    const f = fixture();
    const unavailable: OpenCodeRunResult = {
      exitCode: 1,
      output: "",
      errorOutput: "provider unavailable",
      sessionId: "session",
      failureClassification: "dependency-outage",
    };
    let store = f.store;
    for (let window = 0; window < 5; window += 1) {
      await expect(
        runPrimaryOperation({
          ...options(
            store,
            async () => unavailable,
            async (entry) => stopped(entry),
          ),
          sessionId: "session",
        }),
      ).rejects.toBeInstanceOf(PrimaryOperationWaitingError);
      const operation = store.read("card")?.primaryOperations?.op;
      expect(operation).toMatchObject({
        status: "failed",
        executions: window + 1,
        failureExecutions: 0,
        dependencyOutages: window + 1,
        retrySafe: true,
        lastSessionId: "session",
      });
      store = new TaskExecutionStore(path.join(f.root, "state"), f.project);
    }
    await expect(
      runPrimaryOperation({
        ...options(
          store,
          async () => success,
          async () => ({ status: "unknown" }),
        ),
        sessionId: "session",
      }),
    ).resolves.toMatchObject(success);
    expect(store.read("card")?.primaryOperations?.op).toMatchObject({
      status: "completed",
      executions: 6,
      failureExecutions: 0,
      dependencyOutages: 5,
      lastSessionId: "session",
    });
  });
  it("does not mistake ordinary quality failures for dependency outages", async () => {
    const f = fixture();
    const negative: OpenCodeRunResult = {
      exitCode: 1,
      output: "The requested change cannot be made safely",
      errorOutput: "quality concern",
    };
    await expect(
      runPrimaryOperation(
        options(
          f.store,
          async () => negative,
          async (entry) => stopped(entry),
        ),
      ),
    ).rejects.toBeInstanceOf(PrimaryOperationExhaustedError);
    expect(f.store.read("card")?.primaryOperations?.op).toMatchObject({
      status: "exhausted",
      executions: 3,
      failureExecutions: 3,
      dependencyOutages: 0,
    });
  });
  it("does not classify ordinary agent output containing transport words or status JSON", async () => {
    const f = fixture();
    const negative: OpenCodeRunResult = {
      exitCode: 1,
      output: 'The test emitted {"status":503}; debug says ECONNRESET',
      errorOutput: "quality failure",
    };
    await expect(
      runPrimaryOperation(
        options(
          f.store,
          async () => negative,
          async (entry) => stopped(entry),
        ),
      ),
    ).rejects.toBeInstanceOf(PrimaryOperationExhaustedError);
    expect(f.store.read("card")?.primaryOperations?.op).toMatchObject({
      failureExecutions: 3,
      dependencyOutages: 0,
    });
  });
  it("charges each stopped crash once after outage windows, including after restart", async () => {
    const f = fixture();
    const outage: OpenCodeRunResult = {
      exitCode: 1,
      output: "",
      errorOutput: "provider unavailable",
      failureClassification: "dependency-outage",
    };
    await expect(
      runPrimaryOperation(
        options(
          f.store,
          async () => outage,
          async (entry) => stopped(entry),
        ),
      ),
    ).rejects.toBeInstanceOf(PrimaryOperationWaitingError);
    let store = new TaskExecutionStore(path.join(f.root, "state"), f.project);
    const crash = { ...failure, errorOutput: "agent crashed" };
    beginPrimaryExecution(store, "card", "op", "work", "session");
    completePrimaryExecution(store, "card", "op", "failed", crash);
    reconcilePendingPrimaryExecution(store, "card", "op", "stopped");
    expect(store.read("card")?.primaryOperations?.op?.failureExecutions).toBe(
      1,
    );
    store = new TaskExecutionStore(path.join(f.root, "state"), f.project);
    // Replaying stopped reconciliation after restart is idempotent.
    reconcilePendingPrimaryExecution(store, "card", "op", "stopped");
    expect(store.read("card")?.primaryOperations?.op?.failureExecutions).toBe(
      1,
    );
    await expect(
      runPrimaryOperation(
        options(
          store,
          async () => crash,
          async (current) => stopped(current),
        ),
      ),
    ).rejects.toBeInstanceOf(PrimaryOperationExhaustedError);
    const entry = store.read("card")?.primaryOperations?.op;
    expect(entry).toMatchObject({
      status: "exhausted",
      executions: 4,
      failureExecutions: 3,
      dependencyOutages: 1,
    });
  });
  it("carries cumulative accounting but clears per-execution proof when reserving a retry", () => {
    const f = fixture();
    beginPrimaryExecution(f.store, "card", "op", "work", "session");
    bindPrimaryExecutionEvidence(f.store, "card", "op", 1, {
      executionId: "exec-1",
      metadataPath: "/trusted/exec-1/metadata.json",
      artifactRoot: "/trusted/exec-1",
    });
    completePrimaryExecution(f.store, "card", "op", "failed", failure);
    reconcilePendingPrimaryExecution(f.store, "card", "op", "stopped");
    expect(f.store.read("card")?.primaryOperations?.op).toMatchObject({
      retrySafe: true,
      resultArtifact: expect.any(Object),
      processExecutionId: "exec-1",
    });

    beginPrimaryExecution(f.store, "card", "op", "work", "session");
    expect(f.store.read("card")?.primaryOperations?.op).toMatchObject({
      status: "dispatched",
      executions: 2,
      failureExecutions: 1,
      dependencyOutages: 0,
      lastSessionId: "session",
    });
    expect(f.store.read("card")?.primaryOperations?.op).not.toHaveProperty(
      "retrySafe",
    );
    expect(f.store.read("card")?.primaryOperations?.op).not.toHaveProperty(
      "resultArtifact",
    );
    expect(f.store.read("card")?.primaryOperations?.op).not.toHaveProperty(
      "processExecutionId",
    );
    expect(f.store.read("card")?.primaryOperations?.op).not.toHaveProperty(
      "processMetadataPath",
    );
    expect(f.store.read("card")?.primaryOperations?.op).not.toHaveProperty(
      "processArtifactRoot",
    );
    expect(f.store.read("card")?.primaryOperations?.op).not.toHaveProperty(
      "accountedExecution",
    );
    expect(f.store.read("card")?.primaryOperations?.op).not.toHaveProperty(
      "lastExecutionClassification",
    );
  });
  it("does not reuse outage stop authorization after the next execution becomes uncertain", async () => {
    const f = fixture();
    const outage: OpenCodeRunResult = {
      exitCode: 1,
      output: "",
      errorOutput: "temporary provider failure",
      failureClassification: "dependency-outage",
    };
    await expect(
      runPrimaryOperation(
        options(
          f.store,
          async () => outage,
          async (entry) => stopped(entry),
        ),
      ),
    ).rejects.toBeInstanceOf(PrimaryOperationWaitingError);
    await expect(
      runPrimaryOperation(
        options(
          f.store,
          async () => failure,
          async () => ({ status: "unknown" }),
        ),
      ),
    ).rejects.toBeInstanceOf(PrimaryOperationWaitingError);
    const restarted = new TaskExecutionStore(
      path.join(f.root, "state"),
      f.project,
    );
    const forbiddenDispatch = vi.fn(async () => success);
    await expect(
      runPrimaryOperation(
        options(restarted, forbiddenDispatch, async () => ({
          status: "unknown",
        })),
      ),
    ).rejects.toBeInstanceOf(PrimaryOperationWaitingError);
    expect(forbiddenDispatch).not.toHaveBeenCalled();
    const continued = await runPrimaryOperation(
      options(
        restarted,
        async () => success,
        async (entry) => stopped(entry),
      ),
    );
    expect(continued.exitCode).toBe(0);
    expect(restarted.read("card")?.primaryOperations?.op).toMatchObject({
      executions: 3,
      failureExecutions: 1,
      dependencyOutages: 1,
      status: "completed",
    });
  });
  it("charges interrupted dispatched and ambiguous reservations once after restart", () => {
    const f = fixture();
    for (let execution = 1; execution <= 3; execution += 1) {
      beginPrimaryExecution(f.store, "card", "op", "work", "session");
      if (execution % 2 === 0)
        reconcilePendingPrimaryExecution(f.store, "card", "op", "unknown");
      const restarted = new TaskExecutionStore(
        path.join(f.root, "state"),
        f.project,
      );
      reconcilePendingPrimaryExecution(restarted, "card", "op", "stopped");
      expect(restarted.read("card")?.primaryOperations?.op).toMatchObject({
        executions: execution,
        failureExecutions: execution,
        accountedExecution: execution,
        status: execution === 3 ? "exhausted" : "failed",
      });
      const revision = restarted.read("card")!.revision;
      reconcilePendingPrimaryExecution(restarted, "card", "op", "stopped");
      expect(restarted.read("card")!.revision).toBe(revision);
    }
  });
  it("does not retry cancellation; accepts typed stopped timeout proof", async () => {
    const f = fixture();
    await expect(
      runPrimaryOperation(
        options(
          f.store,
          async () => {
            throw new OpenCodeRunAbortedError();
          },
          async () => ({ status: "never-dispatched" }),
        ),
      ),
    ).rejects.toBeInstanceOf(PrimaryOperationWaitingError);
    const g = fixture();
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new OpenCodeTimeoutError(100, "exec", true))
      .mockResolvedValue(success);
    await expect(
      runPrimaryOperation(
        options(g.store, execute, async (e: PrimaryOperationEntry) =>
          stopped(e),
        ),
      ),
    ).resolves.toMatchObject(success);
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("waits on classified outage proof after a thrown stopped timeout without charging failure", async () => {
    const f = fixture();
    for (let n = 0; n < 2; n += 1) {
      beginPrimaryExecution(f.store, "card", "op", "work", "session");
      completePrimaryExecution(f.store, "card", "op", "failed", failure);
      reconcilePendingPrimaryExecution(f.store, "card", "op", "stopped");
    }
    const execute = vi
      .fn()
      .mockRejectedValue(new OpenCodeTimeoutError(100, "exec", true));
    await expect(
      runPrimaryOperation(
        options(f.store, execute, async (entry) => ({
          ...stopped(entry),
          failureClassification: "dependency-outage",
        })),
      ),
    ).rejects.toBeInstanceOf(PrimaryOperationWaitingError);
    expect(execute).toHaveBeenCalledOnce();
    expect(f.store.read("card")?.primaryOperations?.op).toMatchObject({
      executions: 3,
      failureExecutions: 2,
      dependencyOutages: 1,
      accountedExecution: 3,
      lastExecutionClassification: "dependency-outage",
      status: "failed",
    });
  });
  it("stores large results outside the bounded task record and replays them", async () => {
    const f = fixture();
    const large = {
      ...success,
      output: "x".repeat(1_100_000),
    };
    await expect(
      runPrimaryOperation(
        options(
          f.store,
          async () => large,
          async () => ({ status: "unknown" }),
        ),
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(JSON.stringify(f.store.read("card")).length).toBeLessThan(100_000);
    const replay = await runPrimaryOperation(
      options(f.store, vi.fn(), vi.fn()),
    );
    expect(replay.output.length).toBe(1_100_000);
  });
  it("redacts cached output against the current secret registry without writing", async () => {
    const f = fixture();
    await runPrimaryOperation(
      options(
        f.store,
        async () => ({ ...success, output: "new-current-canary" }),
        async () => ({ status: "unknown" }),
      ),
    );
    registerProcessSecrets(["new-current-canary"]);
    const record = f.store.read("card")!;
    void record;
    const revision = f.store.read("card")!.revision;
    const result = await runPrimaryOperation(
      options(f.store, vi.fn(), vi.fn()),
    );
    expect(result.output).not.toContain("new-current-canary");
    expect(f.store.read("card")!.revision).toBe(revision);
  });

  it("reconciles process-finalized success after restart before ledger completion without dispatch", async () => {
    const f = fixture();
    beginPrimaryExecution(f.store, "card", "op", "work", "session");
    const artifactRoot = path.join(f.root, "process-artifacts");
    const executionRoot = path.join(artifactRoot, "exec");
    fs.mkdirSync(executionRoot, { recursive: true });
    const metadataPath = path.join(executionRoot, "execution.json");
    bindPrimaryExecutionEvidence(f.store, "card", "op", 1, {
      executionId: "exec",
      metadataPath,
      artifactRoot,
    });
    const processResult = {
      exitCode: 0,
      output: "finished before ledger CAS",
      errorOutput: "",
      processExecutionId: "exec",
      sessionId: "session",
    };
    const resultBytes = Buffer.from(JSON.stringify(processResult));
    fs.writeFileSync(path.join(executionRoot, "result.json"), resultBytes);
    fs.writeFileSync(
      metadataPath,
      JSON.stringify({
        executionId: "exec",
        cwd: fs.realpathSync(f.project.repository.path),
        status: "success",
        exitCode: 0,
        treeStopped: true,
        sessionId: "session",
        resultArtifact: {
          path: "result.json",
          sha256: createHash("sha256").update(resultBytes).digest("hex"),
        },
      }),
    );

    // A real new Node process reconstructs the store and replays only finalized
    // process evidence. execute() is deliberately unreachable in the child.
    const childScript = `
      import { TaskExecutionStore } from ${JSON.stringify(new URL("../src/task-session/task-execution-store.ts", import.meta.url).href)};
      import { runPrimaryOperation } from ${JSON.stringify(new URL("../src/task-session/run-primary-operation.ts", import.meta.url).href)};
      import { inspectPrimaryOperationEvidence } from ${JSON.stringify(new URL("../src/task-session/inspect-primary-operation.ts", import.meta.url).href)};
      const f = JSON.parse(process.env.PRIMARY_FIXTURE);
      const store = new TaskExecutionStore(f.state, f.project);
      const result = await runPrimaryOperation({
        store, cardId: "card", operationId: "op", activity: "work", sessionId: "session",
        execute: async () => { throw new Error("must not dispatch after finalized success"); },
        inspectPending: (entry) => inspectPrimaryOperationEvidence(store, "card", "op", { trustedRoot: f.artifactRoot, cwd: f.cwd }),
      });
      process.stdout.write(JSON.stringify({ result, entry: store.read("card").primaryOperations.op }));
    `;
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", childScript],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          HOME: process.env.HOME ?? "",
          PATH: process.env.PATH ?? "",
          TMPDIR: process.env.TMPDIR ?? "",
          PRIMARY_FIXTURE: JSON.stringify({
            state: path.join(f.root, "state"),
            project: f.project,
            artifactRoot,
            cwd: f.project.repository.path,
          }),
        },
      },
    );
    expect(child.status, child.stderr).toBe(0);
    const replay = JSON.parse(child.stdout) as {
      result: OpenCodeRunResult;
      entry: PrimaryOperationEntry;
    };
    expect(replay.result).toMatchObject(processResult);
    expect(replay.entry).toMatchObject({ executions: 1, status: "completed" });
    expect(f.store.read("card")?.primaryOperations?.op).toMatchObject({
      executions: 1,
      status: "completed",
    });
  });
});
