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
  PrimaryOperationExhaustedError,
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
