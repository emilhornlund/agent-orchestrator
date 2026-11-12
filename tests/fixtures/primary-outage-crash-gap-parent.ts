import fs from "node:fs";
import path from "node:path";
import { OpenCodeClient } from "../../src/opencode/opencode-client.js";
import { CommandRunner } from "../../src/process/command-runner.js";
import { configureProcessRuntime } from "../../src/process/process-runtime.js";
import {
  beginPrimaryExecution,
  bindPrimaryExecutionEvidence,
  completePrimaryExecution,
  reconcilePendingPrimaryExecution,
} from "../../src/task-session/primary-operation-ledger.js";
import { inspectPrimaryOperationEvidence } from "../../src/task-session/inspect-primary-operation.js";
import { runPrimaryOperation } from "../../src/task-session/run-primary-operation.js";
import { TaskExecutionStore } from "../../src/task-session/task-execution-store.js";
import type { ProjectConfig } from "../../src/config/config.js";

const inputPath = process.env.PRIMARY_PARENT_INPUT!;
const input = JSON.parse(fs.readFileSync(inputPath, "utf8")) as {
  root: string;
  cwd: string;
  project: ProjectConfig;
  phase: "crash" | "recover" | "resume";
};
const { root, cwd, project, phase } = input;
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
    operationKey: "attempt-1",
    revision: 1,
    retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
    createdAt: now,
    updatedAt: now,
  });
  for (let count = 0; count < 2; count += 1) {
    beginPrimaryExecution(store, cardId, operationId, "implementation", "ses_primary");
    completePrimaryExecution(store, cardId, operationId, "failed", {
      exitCode: 1,
      output: "ordinary implementation failure",
      errorOutput: "",
      sessionId: "ses_primary",
    });
    reconcilePendingPrimaryExecution(store, cardId, operationId, "stopped");
  }
}
const openCode = new OpenCodeClient();
const commands = new CommandRunner();
const inspect = async () => {
  const availability = await commands.run({
    command: "opencode session list",
    cwd,
    timeoutMilliseconds: 10_000,
    signal: new AbortController().signal,
  });
  if (availability.exitCode !== 0) return { status: "unknown" as const };
  return inspectPrimaryOperationEvidence(store, cardId, operationId, {
    trustedRoot: process.env.PRIMARY_RUNTIME_ROOT!,
    cwd,
  });
};
try {
  const result = await runPrimaryOperation({
    store,
    cardId,
    operationId,
    activity: "implementation",
    sessionId: "ses_primary",
    execute: async () => {
      const value = await openCode.run({
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
            store.read(cardId)?.primaryOperations?.[operationId]?.executions ?? -1,
            evidence,
          );
        },
      });
      if (phase === "crash") {
        process.stdout.write("RESULT_PERSISTED\n");
        await new Promise<never>(() => {});
      }
      return value;
    },
    inspectPending: inspect,
  });
  process.stdout.write(
    `${JSON.stringify({ status: "completed", output: result.output, entry: store.read(cardId)?.primaryOperations?.[operationId] })}\n`,
  );
} catch (error) {
  if (phase === "recover") {
    const proof = await inspectPrimaryOperationEvidence(store, cardId, operationId, {
      trustedRoot: process.env.PRIMARY_RUNTIME_ROOT!,
      cwd,
    });
    if (
      proof.status !== "stopped-after-dispatch" ||
      proof.failureClassification !== "dependency-outage"
    )
      throw new Error("Fresh parent did not recover verified dependency-outage evidence", {
        cause: error,
      });
    const before = store.read(cardId)?.primaryOperations?.[operationId];
    reconcilePendingPrimaryExecution(
      store,
      cardId,
      operationId,
      "stopped",
      undefined,
      proof.failureClassification,
    );
    reconcilePendingPrimaryExecution(
      store,
      cardId,
      operationId,
      "stopped",
      undefined,
      proof.failureClassification,
    );
    const after = store.read(cardId)?.primaryOperations?.[operationId];
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error("Repeated stopped-proof reconciliation changed ledger accounting", {
        cause: error,
      });
  }
  process.stdout.write(
    `${JSON.stringify({ status: "waiting", error: String(error), entry: store.read(cardId)?.primaryOperations?.[operationId] })}\n`,
  );
}
