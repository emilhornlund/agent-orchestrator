import fs from "node:fs";
import path from "node:path";
import { OpenCodeClient } from "../../src/opencode/opencode-client.js";
import { inspectPrimaryOpenCodeSession } from "../../src/opencode/inspect-primary-session.js";
import { CommandRunner } from "../../src/process/command-runner.js";
import { configureProcessRuntime } from "../../src/process/process-runtime.js";
import {
  bindPrimaryExecutionEvidence,
  PrimaryOperationExhaustedError,
} from "../../src/task-session/primary-operation-ledger.js";
import { persistPrimaryOperationRecovery } from "../../src/task-session/persist-primary-operation-recovery.js";
import {
  reconcileTaskSession,
  type TaskSessionRecoverySnapshot,
} from "../../src/task-session/reconcile-task-session.js";
import { inspectPrimaryOperationEvidence } from "../../src/task-session/inspect-primary-operation.js";
import {
  PrimaryOperationWaitingError,
  runPrimaryOperation,
} from "../../src/task-session/run-primary-operation.js";
import { TaskExecutionStore } from "../../src/task-session/task-execution-store.js";
import type { ProjectConfig } from "../../src/config/config.js";

const inputPath = process.env.PRIMARY_PARENT_INPUT;
if (!inputPath) throw new Error("PRIMARY_PARENT_INPUT is required");
const input = JSON.parse(fs.readFileSync(inputPath, "utf8")) as {
  root: string;
  cwd: string;
  project: ProjectConfig;
  published: boolean;
};
const { root, cwd, project, published } = input;
fs.mkdirSync(project.repository.path, { recursive: true });
configureProcessRuntime({
  runtimeRoot: process.env.PRIMARY_RUNTIME_ROOT!,
  signal: new AbortController().signal,
});
const store = new TaskExecutionStore(path.join(root, "state"), project);
const cardId = "card";
const operationId = "primary";
if (!store.read(cardId)) {
  const now = new Date().toISOString();
  store.create({
    version: 1,
    projectId: project.id,
    cardId,
    phase: "implementation",
    primarySessionId: "ses_primary",
    sessionCreationStatus: "bound",
    expectedBranch: "agent/card",
    ...(published
      ? { pullRequest: { number: 9, url: "https://github.com/o/r/pull/9" } }
      : {}),
    operationKey: "attempt-1",
    revision: 1,
    retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
    createdAt: now,
    updatedAt: now,
  });
}

const now =
  process.env.PRIMARY_PARENT_NOW === undefined
    ? Date.now()
    : Number(process.env.PRIMARY_PARENT_NOW);
const record = store.read(cardId)!;
const snapshot: TaskSessionRecoverySnapshot = {
  primarySessionAccessible: "reachable",
  worktreeExists: true,
  worktreeBranch: "agent/card",
  worktreeHeadSha: "a".repeat(40),
  worktreeRebaseActive: false,
  trustedCommitSha: null,
  remoteBranchHeadSha: null,
  trelloListId: "working",
  pullRequest:
    record.pullRequest === undefined
      ? null
      : {
          number: record.pullRequest.number,
          url: record.pullRequest.url,
          headSha: record.pullRequest.headSha ?? "a".repeat(40),
          state: "OPEN",
        },
  ciEvaluation: null,
  feedbackHeadSha: null,
  uncertainReplyIds: [],
  reconciledReplyIds: [],
};
const recovery = await reconcileTaskSession({
  project,
  cardId,
  expectedBranch: "agent/card",
  operationKey: record.operationKey,
  worktreePath: cwd,
  taskRecordStore: store,
  retryIntervalMs: 1_000,
  now: () => now,
  readAuthoritativeSnapshot: async () => snapshot,
});
if (recovery.status === "waiting") {
  process.stdout.write(
    `${JSON.stringify({ status: "waiting", retryAt: recovery.record.recoveryWait?.retryAt })}\n`,
  );
  process.exit(0);
}
if (recovery.status !== "resume")
  throw new Error(
    `Expected production recovery to resume; got ${recovery.status}`,
  );

const openCode = new OpenCodeClient();
const commands = new CommandRunner();
try {
  const result = await runPrimaryOperation({
    store,
    cardId,
    operationId,
    activity: "implementation",
    sessionId: "ses_primary",
    execute: () =>
      openCode.run({
        cwd,
        timeoutMilliseconds: 10_000,
        prompt: "continue implementation",
        sessionId: "ses_primary",
        signal: new AbortController().signal,
        onExecutionPrepared: (evidence) => {
          bindPrimaryExecutionEvidence(
            store,
            cardId,
            operationId,
            store.read(cardId)?.primaryOperations?.[operationId]?.executions ??
              -1,
            evidence,
          );
        },
      }),
    inspectPending: async () => {
      const availability = await inspectPrimaryOpenCodeSession({
        commands,
        cwd,
        sessionId: "ses_primary",
        signal: new AbortController().signal,
        timeoutMilliseconds: 10_000,
      });
      if (availability !== "reachable") return { status: "unknown" };
      return inspectPrimaryOperationEvidence(store, cardId, operationId, {
        trustedRoot: process.env.PRIMARY_RUNTIME_ROOT!,
        cwd,
      });
    },
  });
  fs.writeFileSync(path.join(cwd, "primary-cli-result.txt"), result.output);
  process.stdout.write(
    `${JSON.stringify({ status: "completed", executions: store.read(cardId)?.primaryOperations?.[operationId]?.executions })}\n`,
  );
} catch (error) {
  const current = store.read(cardId)!;
  if (error instanceof PrimaryOperationWaitingError) {
    persistPrimaryOperationRecovery(store, current, error, 1_000);
    process.stdout.write(
      `${JSON.stringify({ status: "waiting", retryAt: store.read(cardId)?.recoveryWait?.retryAt })}\n`,
    );
  } else if (error instanceof PrimaryOperationExhaustedError) {
    const disposition = persistPrimaryOperationRecovery(
      store,
      current,
      error,
      1_000,
    );
    process.stdout.write(
      `${JSON.stringify({ status: "exhausted", disposition, executions: store.read(cardId)?.primaryOperations?.[operationId]?.executions })}\n`,
    );
  } else {
    throw error;
  }
}
