import type { OpenCodeRunResult } from "../opencode/opencode-client.js";
import { OpenCodeTimeoutError } from "../opencode/opencode-client.js";
import {
  beginPrimaryExecution,
  completePrimaryExecution,
  getCompletedPrimaryExecutionResult,
  PrimaryOperationBlockedError,
  PrimaryOperationExhaustedError,
  reconcilePendingPrimaryExecution,
} from "./primary-operation-ledger.js";
import type { TaskExecutionStore } from "./task-execution-store.js";
import type { TaskExecutionRecord } from "./task-execution-record.js";
export type PrimaryOperationEntry = NonNullable<
  NonNullable<TaskExecutionRecord["primaryOperations"]>[string]
>;
type OperationEntry = PrimaryOperationEntry;

export type PendingPrimaryInspection =
  | { status: "never-dispatched" }
  | {
      status: "stopped-after-dispatch";
      operationId: string;
      execution: number;
      sessionId?: string;
    }
  | { status: "running" }
  | { status: "completed"; result: OpenCodeRunResult }
  | { status: "unknown" };

export class PrimaryOperationWaitingError extends Error {
  readonly operationId: string;
  constructor(operationId: string, options?: ErrorOptions) {
    super(
      `Primary operation ${operationId} is waiting for authoritative reconciliation`,
      options,
    );
    this.name = "PrimaryOperationWaitingError";
    this.operationId = operationId;
  }
}

export interface RunPrimaryOperationOptions {
  store: TaskExecutionStore;
  cardId: string;
  operationId: string;
  activity: string;
  sessionId?: string;
  execute: () => Promise<OpenCodeRunResult>;
  inspectPending: (entry: OperationEntry) => Promise<PendingPrimaryInspection>;
}

export async function runPrimaryOperation(
  options: RunPrimaryOperationOptions,
): Promise<OpenCodeRunResult> {
  const { store, cardId, operationId, activity } = options;
  const entry = store.read(cardId)?.primaryOperations?.[operationId];
  if (entry && entry.activity !== activity)
    throw new PrimaryOperationBlockedError(
      "Primary operation ID is assigned to another activity",
    );
  if (entry?.status === "completed") {
    const result = getCompletedPrimaryExecutionResult(
      store,
      cardId,
      operationId,
    );
    if (result) return result;
    const inspected = await inspect(options, entry);
    if (inspected.status === "completed") {
      if (inspected.result.exitCode !== 0)
        throw new PrimaryOperationWaitingError(operationId);
      reconcilePendingPrimaryExecution(
        store,
        cardId,
        operationId,
        "completed",
        inspected.result,
      );
      return getCompletedPrimaryExecutionResult(store, cardId, operationId)!;
    }
    throw new PrimaryOperationWaitingError(operationId);
  }
  if (entry?.status === "exhausted")
    throw new PrimaryOperationExhaustedError(
      entry.diagnostic ?? `Primary operation ${operationId} exhausted`,
    );
  if (entry && !(entry.status === "failed" && entry.retrySafe === true)) {
    const inspected = await inspect(options, entry);
    if (inspected.status === "completed") {
      if (inspected.result.exitCode !== 0) {
        reconcilePendingPrimaryExecution(store, cardId, operationId, "unknown");
        throw new PrimaryOperationWaitingError(operationId);
      }
      reconcilePendingPrimaryExecution(
        store,
        cardId,
        operationId,
        "completed",
        inspected.result,
      );
      return getCompletedPrimaryExecutionResult(store, cardId, operationId)!;
    }
    if (inspected.status === "unknown" || inspected.status === "running") {
      if (["dispatched", "ambiguous", "intent"].includes(entry.status))
        reconcilePendingPrimaryExecution(store, cardId, operationId, "unknown");
      throw new PrimaryOperationWaitingError(operationId);
    }
    if (inspected.status === "never-dispatched")
      reconcilePendingPrimaryExecution(
        store,
        cardId,
        operationId,
        "not-dispatched",
      );
    else {
      if (
        inspected.operationId !== operationId ||
        inspected.execution !== entry.executions ||
        (entry.lastSessionId !== undefined &&
          inspected.sessionId !== entry.lastSessionId)
      )
        throw new PrimaryOperationWaitingError(operationId);
      reconcilePendingPrimaryExecution(store, cardId, operationId, "stopped");
      const stoppedEntry = store.read(cardId)?.primaryOperations?.[operationId];
      if (stoppedEntry?.status === "exhausted")
        throw new PrimaryOperationExhaustedError(
          stoppedEntry.diagnostic ?? "Execution budget exhausted",
        );
    }
  }
  for (;;) {
    try {
      beginPrimaryExecution(
        store,
        cardId,
        operationId,
        activity,
        options.sessionId,
      );
    } catch (error) {
      if (error instanceof PrimaryOperationExhaustedError) {
        const exhausted = store.read(cardId)?.primaryOperations?.[operationId];
        if (exhausted?.status === "exhausted")
          throw new PrimaryOperationExhaustedError(
            exhausted.diagnostic ?? error.message,
          );
      }
      throw error;
    }
    let result: OpenCodeRunResult;
    try {
      result = await options.execute();
    } catch (error) {
      if (!(error instanceof OpenCodeTimeoutError && error.treeStopped)) {
        completePrimaryExecution(
          store,
          cardId,
          operationId,
          "ambiguous",
          undefined,
          String(error),
        );
        throw new PrimaryOperationWaitingError(operationId, { cause: error });
      }
      const failure = {
        exitCode: 1,
        output: "",
        errorOutput: error.message,
        ...(error.executionId === undefined
          ? {}
          : { processExecutionId: error.executionId }),
        ...(options.sessionId === undefined
          ? {}
          : { sessionId: options.sessionId }),
      };
      const record = completePrimaryExecution(
        store,
        cardId,
        operationId,
        "failed",
        failure,
        error.message,
      );
      if (record.primaryOperations?.[operationId]?.status === "exhausted")
        throw new PrimaryOperationExhaustedError(
          record.primaryOperations[operationId]!.diagnostic ?? error.message,
        );
      const next = record.primaryOperations![operationId]!;
      const proof = await inspect(options, next);
      if (
        proof.status !== "stopped-after-dispatch" ||
        proof.operationId !== operationId ||
        proof.execution !== next.executions ||
        (next.lastSessionId !== undefined &&
          proof.sessionId !== next.lastSessionId)
      )
        throw new PrimaryOperationWaitingError(operationId);
      const resolved = reconcilePendingPrimaryExecution(
        store,
        cardId,
        operationId,
        "stopped",
      );
      if (resolved.primaryOperations?.[operationId]?.status === "exhausted")
        throw new PrimaryOperationExhaustedError(
          resolved.primaryOperations[operationId]!.diagnostic ??
            "Execution budget exhausted",
        );
      continue;
    }
    if (result.exitCode === 0) {
      completePrimaryExecution(store, cardId, operationId, "completed", result);
      return getCompletedPrimaryExecutionResult(store, cardId, operationId)!;
    }
    const record = completePrimaryExecution(
      store,
      cardId,
      operationId,
      "failed",
      result,
      result.errorOutput || `exit ${result.exitCode}`,
    );
    const saved = record.primaryOperations![operationId]!;
    if (saved.status === "exhausted")
      throw new PrimaryOperationExhaustedError(
        saved.diagnostic ?? "Primary operation exhausted",
      );
    const proof = await inspect(options, saved);
    if (
      proof.status !== "stopped-after-dispatch" ||
      proof.operationId !== operationId ||
      proof.execution !== saved.executions ||
      (proof.sessionId !== undefined && proof.sessionId !== saved.lastSessionId)
    )
      throw new PrimaryOperationWaitingError(operationId);
    reconcilePendingPrimaryExecution(store, cardId, operationId, "stopped");
  }
}

async function inspect(
  options: RunPrimaryOperationOptions,
  entry: OperationEntry,
): Promise<PendingPrimaryInspection> {
  try {
    return await options.inspectPending(entry);
  } catch (error) {
    throw new PrimaryOperationWaitingError(options.operationId, {
      cause: error,
    });
  }
}
