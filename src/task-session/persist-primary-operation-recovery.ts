import { PrimaryOperationExhaustedError } from "./primary-operation-ledger.js";
import { PrimaryOperationWaitingError } from "./run-primary-operation.js";
import { PrimarySessionReconstructionRequiredError } from "./primary-task-session.js";
import type { TaskExecutionRecord } from "./task-execution-record.js";
import { transitionTaskExecutionRecord } from "./task-execution-transition.js";
import type { TaskExecutionStore } from "./task-execution-store.js";
import { OPERATION_RECOVERY_MAX_EXECUTIONS } from "./operation-recovery-policy.js";

export type PrimaryOperationRecoveryDisposition =
  "waiting" | "prepublication-failure" | "published-blockage" | "unhandled";

type PrimaryRecoveryError =
  | PrimaryOperationWaitingError
  | PrimaryOperationExhaustedError
  | PrimarySessionReconstructionRequiredError;

export function findPrimaryRecoveryError(
  error: unknown,
  seen = new Set<unknown>(),
): PrimaryRecoveryError | undefined {
  if (error === null || typeof error !== "object" || seen.has(error))
    return undefined;
  seen.add(error);
  if (
    error instanceof PrimaryOperationWaitingError ||
    error instanceof PrimaryOperationExhaustedError ||
    error instanceof PrimarySessionReconstructionRequiredError
  )
    return error;
  const cause = (error as { cause?: unknown }).cause;
  return findPrimaryRecoveryError(cause, seen);
}

function cleanReason(error: PrimaryRecoveryError): string {
  const description =
    error instanceof PrimaryOperationWaitingError
      ? "Primary operation outcome requires authoritative reconciliation"
      : error instanceof PrimarySessionReconstructionRequiredError
        ? "Primary session reconstruction is required before this operation can continue"
        : "Primary operation execution budget is exhausted";
  return `${description}${"operationId" in error && error.operationId ? ` (${error.operationId})` : ""}`.slice(
    0,
    1_000,
  );
}

export function persistPrimaryOperationRecovery(
  store: TaskExecutionStore,
  record: TaskExecutionRecord,
  error: unknown,
  retryIntervalMs: number,
): PrimaryOperationRecoveryDisposition {
  if (!Number.isSafeInteger(retryIntervalMs) || retryIntervalMs <= 0)
    throw new RangeError(
      "Primary operation retry interval must be a positive safe integer",
    );
  const primaryError = findPrimaryRecoveryError(error);
  if (primaryError === undefined) return "unhandled";
  const current = store.read(record.cardId);
  if (current === null || current.revision !== record.revision)
    throw new Error(
      "Primary operation recovery record changed before persistence",
    );
  if (current.phase === "done" || current.phase === "attention-required")
    return "unhandled";

  const operationId =
    "operationId" in primaryError &&
    typeof primaryError.operationId === "string"
      ? primaryError.operationId
      : current.primaryOperations === undefined
        ? undefined
        : (Object.values(current.primaryOperations)
            .filter((operation) => operation.status !== "completed")
            .at(-1)?.id ?? Object.keys(current.primaryOperations).at(-1));
  if (operationId === undefined) return "unhandled";
  const operation = current.primaryOperations?.[operationId];
  const exhausted = primaryError instanceof PrimaryOperationExhaustedError;
  if (
    exhausted &&
    (operation?.status !== "exhausted" ||
      (operation.failureExecutions ?? operation.executions) <
        OPERATION_RECOVERY_MAX_EXECUTIONS)
  )
    return "unhandled";

  const reason = cleanReason(primaryError);
  const nextAt = new Date(Date.now() + retryIntervalMs).toISOString();
  const recoveryWait = {
    kind: "dependency" as const,
    reason,
    resumePhase: current.phase,
    since: current.recoveryWait?.since ?? new Date().toISOString(),
    retryAt: nextAt,
    attempts: (current.recoveryWait?.attempts ?? 0) + 1,
    notificationId: `${current.operationKey}/primary/${operationId}`,
  };
  if (!exhausted) {
    store.compareAndSwap(current.cardId, current.revision, {
      ...current,
      recoveryWait,
      revision: current.revision + 1,
      updatedAt: new Date(
        Math.max(Date.now(), Date.parse(current.updatedAt) + 1),
      ).toISOString(),
    });
    return "waiting";
  }

  if (current.pullRequest !== undefined) {
    store.compareAndSwap(current.cardId, current.revision, {
      ...current,
      recoveryWait: { ...recoveryWait, reason },
      revision: current.revision + 1,
      updatedAt: new Date(
        Math.max(Date.now(), Date.parse(current.updatedAt) + 1),
      ).toISOString(),
    });
    return "published-blockage";
  }
  const terminal = transitionTaskExecutionRecord(current, {
    type: "attention-required",
    eventId: `${current.operationKey}:primary-exhausted:${operationId}`,
    projectId: current.projectId,
    cardId: current.cardId,
    operationKey: current.operationKey,
    occurredAt: new Date(
      Math.max(Date.now(), Date.parse(current.updatedAt) + 1),
    ).toISOString(),
  });
  store.compareAndSwap(current.cardId, current.revision, {
    ...terminal,
    recoveryWait: undefined,
    terminalFailure: { kind: "implementation", outcome: "pending", reason },
  });
  return "prepublication-failure";
}
