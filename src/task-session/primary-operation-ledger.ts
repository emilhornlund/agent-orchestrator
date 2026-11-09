import { TaskExecutionStore } from "./task-execution-store.js";
import type { TaskExecutionRecord } from "./task-execution-record.js";
import { OPERATION_RECOVERY_MAX_EXECUTIONS } from "./operation-recovery-policy.js";
import {
  redactSecrets,
  sanitizeControlledText,
} from "../security/redact-secrets.js";
import type { OpenCodeRunResult } from "../opencode/opencode-client.js";

export class PrimaryOperationBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrimaryOperationBlockedError";
  }
}
export class PrimaryOperationExhaustedError extends PrimaryOperationBlockedError {
  readonly operationId: string | undefined;
  constructor(message: string) {
    super(message);
    this.name = "PrimaryOperationExhaustedError";
    const match = /Primary operation ([^ ]+)/.exec(message);
    this.operationId = match?.[1];
  }
}

function validateLedgerIdentifiers(
  operationId: string,
  activity: string,
): void {
  for (const [label, value] of [
    ["operation ID", operationId],
    ["activity", activity],
  ] as const) {
    if (Buffer.byteLength(value, "utf8") > 1_024)
      throw new PrimaryOperationBlockedError(
        `Primary operation ${label} exceeds 1024 bytes`,
      );
  }
}

/** Bind pre-spawn process evidence to the exact reserved ledger execution. */
export function bindPrimaryExecutionEvidence(
  store: TaskExecutionStore,
  cardId: string,
  operationId: string,
  expectedExecutions: number,
  evidence: { executionId: string; metadataPath: string; artifactRoot: string },
): TaskExecutionRecord {
  const record = store.read(cardId);
  const operation = record?.primaryOperations?.[operationId];
  validateLedgerIdentifiers(operationId, operation?.activity ?? "");
  if (
    !record ||
    !operation ||
    operation.status !== "dispatched" ||
    operation.executions !== expectedExecutions
  )
    throw new PrimaryOperationBlockedError(
      "Reserved primary execution changed before process evidence binding",
    );
  return store.compareAndSwap(cardId, record.revision, {
    ...record,
    primaryOperations: {
      ...record.primaryOperations,
      [operationId]: {
        ...operation,
        processExecutionId: evidence.executionId,
        processMetadataPath: evidence.metadataPath,
        processArtifactRoot: evidence.artifactRoot,
        updatedAt: nextTimestamp(record.updatedAt),
      },
    },
    revision: record.revision + 1,
    updatedAt: nextTimestamp(record.updatedAt),
  });
}

function nextTimestamp(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

/** Durably consume one execution before dispatch. IDs are caller-owned stable semantic IDs. */
export function beginPrimaryExecution(
  store: TaskExecutionStore,
  cardId: string,
  operationId: string,
  activity: string,
  sessionId?: string,
  role: "primary" | "reconstruction" = "primary",
): TaskExecutionRecord {
  validateLedgerIdentifiers(operationId, activity);
  const record = store.read(cardId);
  if (!record)
    throw new PrimaryOperationBlockedError("Task execution record is missing");
  const operations = { ...(record.primaryOperations ?? {}) };
  // A pending dispatch owns the task's primary-operation slot. Caller-generated
  // counters can reset (or change after a restart), so checking only the
  // requested ID would let a different ID bypass an ambiguous prior operation.
  const unresolved = Object.values(operations).find(
    (operation) =>
      operation !== undefined &&
      ["intent", "dispatched", "ambiguous"].includes(operation.status),
  );
  if (unresolved && unresolved.id !== operationId)
    throw new PrimaryOperationBlockedError(
      `Primary operation ${unresolved.id} has unresolved dispatch state`,
    );
  const prior = operations[operationId];
  if (prior && prior.activity !== activity)
    throw new PrimaryOperationBlockedError(
      "Primary operation ID is already assigned to another activity",
    );
  if (
    prior?.status === "dispatched" ||
    prior?.status === "ambiguous" ||
    prior?.status === "intent"
  )
    throw new PrimaryOperationBlockedError(
      `Primary operation ${operationId} has unresolved dispatch state`,
    );
  if (prior?.status === "completed" || prior?.status === "exhausted")
    throw new PrimaryOperationBlockedError(
      `Primary operation ${operationId} is terminal (${prior.status})`,
    );
  if (prior?.status === "failed" && prior.retrySafe !== true)
    throw new PrimaryOperationBlockedError(
      `Primary operation ${operationId} lacks proof that its prior process stopped`,
    );
  const executions = (prior?.executions ?? 0) + 1;
  if (
    (prior?.failureExecutions ?? prior?.executions ?? 0) >=
    OPERATION_RECOVERY_MAX_EXECUTIONS
  ) {
    throw new PrimaryOperationExhaustedError(
      `Primary operation ${operationId} exhausted its execution budget`,
    );
  }
  operations[operationId] = {
    id: operationId,
    activity,
    role,
    executions,
    failureExecutions: prior?.failureExecutions ?? prior?.executions ?? 0,
    dependencyOutages: prior?.dependencyOutages ?? 0,
    ...((sessionId ?? prior?.lastSessionId) === undefined
      ? {}
      : { lastSessionId: sessionId ?? prior?.lastSessionId }),
    status: "dispatched",
    updatedAt: nextTimestamp(record.updatedAt),
  };
  return store.compareAndSwap(cardId, record.revision, {
    ...record,
    primaryOperations: operations,
    revision: record.revision + 1,
    updatedAt: nextTimestamp(record.updatedAt),
  });
}

export function completePrimaryExecution(
  store: TaskExecutionStore,
  cardId: string,
  operationId: string,
  outcome: "completed" | "failed" | "ambiguous" | "exhausted",
  result?: OpenCodeRunResult,
  diagnostic?: string,
  classification:
    "failure" | "dependency-outage" = result?.failureClassification ===
  "dependency-outage"
    ? "dependency-outage"
    : "failure",
): TaskExecutionRecord {
  const record = store.read(cardId);
  const operation = record?.primaryOperations?.[operationId];
  if (!record || !operation || operation.status !== "dispatched")
    throw new PrimaryOperationBlockedError(
      `No dispatched primary operation ${operationId} to complete`,
    );
  if (
    (outcome === "completed" || outcome === "exhausted") &&
    result === undefined
  )
    throw new PrimaryOperationBlockedError(
      `${outcome} requires an OpenCode result`,
    );
  const resultArtifact =
    result === undefined
      ? undefined
      : store.writePrimaryResultArtifact(operationId, sanitizeResult(result));
  if (outcome === "completed" && result?.exitCode !== 0)
    throw new PrimaryOperationBlockedError(
      "Completed primary operation requires exit code zero",
    );
  const failureExecutions =
    operation.failureExecutions ?? operation.executions - 1;
  const dependencyOutages =
    (operation.dependencyOutages ?? 0) +
    (outcome === "failed" && classification === "dependency-outage" ? 1 : 0);
  const terminalOutcome = outcome;
  const operations = {
    ...record.primaryOperations,
    [operationId]: {
      ...operation,
      status: terminalOutcome,
      failureExecutions,
      dependencyOutages,
      ...(outcome === "failed"
        ? { lastExecutionClassification: classification }
        : {}),
      ...(resultArtifact === undefined ? {} : { resultArtifact }),
      ...(terminalOutcome !== "exhausted" && diagnostic === undefined
        ? {}
        : {
            diagnostic: sanitizeControlledText(
              redactSecrets(diagnostic ?? "Execution budget exhausted"),
            ).slice(0, 2_000),
          }),
      updatedAt: nextTimestamp(record.updatedAt),
    },
  };
  return store.compareAndSwap(cardId, record.revision, {
    ...record,
    primaryOperations: operations,
    revision: record.revision + 1,
    updatedAt: nextTimestamp(record.updatedAt),
  });
}

/** Unknown inspection preserves ambiguity; only authoritative outcomes resolve a pending entry. */
export function reconcilePendingPrimaryExecution(
  store: TaskExecutionStore,
  cardId: string,
  operationId: string,
  result: "completed" | "not-dispatched" | "stopped" | "unknown",
  completedResult?: OpenCodeRunResult,
): TaskExecutionRecord {
  const record = store.read(cardId);
  if (result === "completed" && completedResult === undefined)
    throw new PrimaryOperationBlockedError(
      "Completed reconciliation requires replay result",
    );
  const operation = record?.primaryOperations?.[operationId];
  if (
    record &&
    operation &&
    result === "stopped" &&
    operation.status === "exhausted" &&
    operation.accountedExecution === operation.executions
  )
    return record;
  if (
    !record ||
    !operation ||
    !["dispatched", "ambiguous", "intent", "failed"].includes(operation.status)
  )
    throw new PrimaryOperationBlockedError(
      `No pending primary operation ${operationId}`,
    );
  if (
    result === "stopped" &&
    operation.status === "failed" &&
    operation.retrySafe === true &&
    (operation.lastExecutionClassification === "dependency-outage" ||
      operation.accountedExecution === operation.executions ||
      operation.failureExecutions === undefined)
  )
    return record;
  const status =
    result === "unknown"
      ? "ambiguous"
      : result === "completed"
        ? "completed"
        : result === "stopped" &&
            (operation.failureExecutions ?? operation.executions) >=
              OPERATION_RECOVERY_MAX_EXECUTIONS
          ? "exhausted"
          : result === "stopped"
            ? "failed"
            : "failed";
  const executions =
    result === "not-dispatched"
      ? Math.max(0, operation.executions - 1)
      : operation.executions;
  const legacyFailureBaseline =
    operation.status === "failed" && operation.retrySafe === true
      ? operation.executions
      : Math.max(0, operation.executions - 1);
  const priorFailureExecutions =
    operation.failureExecutions ?? legacyFailureBaseline;
  const verifiedFailure =
    result === "stopped" &&
    operation.status !== "intent" &&
    operation.executions > 0 &&
    operation.lastExecutionClassification !== "dependency-outage" &&
    operation.accountedExecution !== operation.executions &&
    !(
      operation.failureExecutions === undefined &&
      operation.status === "failed" &&
      operation.retrySafe === true
    );
  const failureExecutions = priorFailureExecutions + (verifiedFailure ? 1 : 0);
  const exhausted =
    result === "stopped" &&
    failureExecutions >= OPERATION_RECOVERY_MAX_EXECUTIONS;
  const operations: NonNullable<TaskExecutionRecord["primaryOperations"]> = {
    ...record.primaryOperations,
    [operationId]: {
      ...operation,
      status: exhausted ? "exhausted" : status,
      executions,
      failureExecutions,
      ...(verifiedFailure ? { accountedExecution: operation.executions } : {}),
      ...(result === "stopped" || result === "not-dispatched"
        ? { retrySafe: true }
        : {}),
      ...(result === "completed" &&
      completedResult !== undefined &&
      completedResult.exitCode === 0
        ? {
            resultArtifact: store.writePrimaryResultArtifact(
              operationId,
              sanitizeResult(completedResult),
            ),
          }
        : {}),
      ...(exhausted
        ? {
            diagnostic: `Execution budget exhausted after ${failureExecutions} verified failures`,
          }
        : {}),
      updatedAt: nextTimestamp(record.updatedAt),
    },
  };
  return store.compareAndSwap(cardId, record.revision, {
    ...record,
    primaryOperations: operations,
    revision: record.revision + 1,
    updatedAt: nextTimestamp(record.updatedAt),
  });
}

export function getCompletedPrimaryExecutionResult(
  store: TaskExecutionStore,
  cardId: string,
  operationId: string,
): OpenCodeRunResult | null {
  const operation = store.read(cardId)?.primaryOperations?.[operationId];
  if (
    operation?.status !== "completed" ||
    (operation.resultArtifact === undefined && operation.result === undefined)
  )
    return null;
  const materialized =
    operation.resultArtifact === undefined
      ? operation.result
      : (store.readPrimaryResultArtifact({
          reference: operation.resultArtifact.reference as `sha256:${string}`,
          bytes: operation.resultArtifact.bytes,
          ...(operation.resultArtifact.path === undefined
            ? {}
            : { path: operation.resultArtifact.path }),
        }) as OpenCodeRunResult);
  if (materialized === undefined) return null;
  const result = materialized;
  return {
    exitCode: result.exitCode,
    output: sanitizeControlledText(redactSecrets(result.output)),
    errorOutput: sanitizeControlledText(redactSecrets(result.errorOutput)),
    ...(result.processExecutionId === undefined
      ? {}
      : { processExecutionId: result.processExecutionId }),
    ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
    ...(result.failureClassification === undefined
      ? {}
      : { failureClassification: result.failureClassification }),
  };
}

function sanitizeResult(
  result: OpenCodeRunResult,
): NonNullable<
  NonNullable<TaskExecutionRecord["primaryOperations"]>[string]["result"]
> {
  for (const [label, value] of [
    ["process execution ID", result.processExecutionId],
    ["session ID", result.sessionId],
  ] as const)
    if (value !== undefined && Buffer.byteLength(value, "utf8") > 1_024)
      throw new PrimaryOperationBlockedError(
        `Primary operation ${label} exceeds 1024 bytes`,
      );
  const safe = {
    exitCode: result.exitCode,
    output: sanitizeControlledText(redactSecrets(result.output)),
    errorOutput: sanitizeControlledText(redactSecrets(result.errorOutput)),
    ...(result.processExecutionId === undefined
      ? {}
      : { processExecutionId: result.processExecutionId }),
    ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
    ...(result.failureClassification === undefined
      ? {}
      : { failureClassification: result.failureClassification }),
  };
  return safe;
}
