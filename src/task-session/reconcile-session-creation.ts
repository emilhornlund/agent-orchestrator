import type { TaskExecutionRecord } from "./task-execution-record.js";
import { primaryOperationSchema } from "./task-execution-record.js";
import type { TaskExecutionStore } from "./task-execution-store.js";
import type { ListedOpenCodeSession } from "../opencode/inspect-primary-session.js";
import { OPERATION_RECOVERY_MAX_EXECUTIONS } from "./operation-recovery-policy.js";
import { logger } from "../logging/logger.js";

export function hasPendingSessionCreation(record: TaskExecutionRecord): boolean {
  return (
    ["planning", "attention-required"].includes(record.phase) &&
    ["creating", "ambiguous"].includes(record.sessionCreationStatus ?? "") &&
    record.primarySessionId === undefined &&
    record.pullRequest === undefined &&
    record.terminalFailure === undefined
  );
}

/** Reconcile the original creation before another OpenCode dispatch is allowed.
 * Unknown writer termination is an explicit paced wait, never stopped proof. */
export async function reconcileSessionCreation(options: {
  store: TaskExecutionStore;
  cardId: string;
  cwd: string;
  retryIntervalMs: number;
  verifyOwnership: () => Promise<boolean>;
  readSessions: () => Promise<ListedOpenCodeSession[] | null>;
  now?: () => number;
}): Promise<"not-applicable" | "waiting" | "recovered" | "failed"> {
  const { store, cardId } = options;
  const record = store.read(cardId);
  if (!record || !hasPendingSessionCreation(record)) return "not-applicable";
  if (!Number.isSafeInteger(options.retryIntervalMs) || options.retryIntervalMs < 1)
    throw new Error("Session creation recovery requires a positive retry interval");
  const time = options.now?.() ?? Date.now();
  if (record.recoveryWait && time < Date.parse(record.recoveryWait.retryAt)) return "waiting";
  const updatedAt = new Date(Math.max(time, Date.parse(record.updatedAt) + 1)).toISOString();
  const persist = (patch: Partial<TaskExecutionRecord>) =>
    store.compareAndSwap(cardId, record.revision, {
      ...record,
      phase: "planning",
      recoveryWait: undefined,
      ...patch,
      revision: record.revision + 1,
      updatedAt,
    });
  const wait = (reason: string): "waiting" => {
    if (reason !== record.recoveryWait?.reason)
      logger.child({ projectId: record.projectId, cardId }).warn(reason);
    persist({
      recoveryWait: {
        kind: "dependency",
        reason,
        resumePhase: "planning",
        since: record.recoveryWait?.since ?? updatedAt,
        retryAt: new Date(time + options.retryIntervalMs).toISOString(),
        attempts: (record.recoveryWait?.attempts ?? 0) + 1,
        notificationId: `${record.operationKey}/session-creation`,
      },
    });
    return "waiting";
  };
  let owned: boolean;
  try {
    owned = await options.verifyOwnership();
  } catch {
    owned = false;
  }
  if (!owned)
    return wait("Initial session recovery awaits verified card, worktree and queue ownership");
  const executionId = record.sessionCreationExecutionId;
  let metadata: Record<string, unknown> | null = null;
  if (executionId) {
    try {
      const raw = store.readProcessExecution(cardId, executionId, "process-executions");
      if (raw && typeof raw === "object" && !Array.isArray(raw))
        metadata = raw as Record<string, unknown>;
    } catch {
      /* Unreadable evidence is not absence or stopped proof. */
    }
    const commandMatches =
      record.sessionCreationCommand !== undefined
        ? metadata?.command === record.sessionCreationCommand
        : typeof metadata?.command === "string" &&
          /^opencode run(?: --(?:model|variant) [^\r\n]+)?$/u.test(metadata.command);
    if (
      !metadata ||
      metadata.executionId !== executionId ||
      metadata.cwd !== options.cwd ||
      !commandMatches
    )
      return wait("Initial session recovery awaits valid original process evidence");
    if (
      (metadata.failureClassification !== undefined &&
        metadata.failureClassification !== "dependency-outage") ||
      (metadata.status === "success" && metadata.exitCode !== 0) ||
      (metadata.status === "nonzero" &&
        (!Number.isSafeInteger(metadata.exitCode) || metadata.exitCode === 0))
    )
      return wait("Initial session recovery awaits consistent original process outcome");
    const neverDispatched =
      metadata.status === "not-dispatched" ||
      (metadata.status === "spawn-failure" && metadata.dispatchState === "not-dispatched");
    if (
      !neverDispatched &&
      !(
        metadata.treeStopped === true &&
        [
          "success",
          "nonzero",
          "timeout",
          "interrupted",
          "evidence-failure",
          "spawn-failure",
        ].includes(String(metadata.status))
      )
    )
      return wait(
        "Initial session recovery awaits authoritative process-tree termination evidence",
      );
  } else if (!record.sessionCreationTitle) {
    return wait(
      "Legacy initial session creation lacks dispatch provenance; operator evidence is required",
    );
  }
  // For new intents the evidence callback is awaited before spawn; no execution
  // identity means dispatch never began. Legacy records cannot use that rule.
  let sessions: ListedOpenCodeSession[] | null;
  try {
    sessions = await options.readSessions();
  } catch {
    sessions = null;
  }
  if (!sessions)
    return wait("Initial session recovery awaits a complete authoritative session inventory");
  let result: NonNullable<TaskExecutionRecord["primaryOperations"]>[string]["result"] = undefined;
  let resultUnavailable = false;
  try {
    const raw = executionId ? store.readProcessResult(cardId, executionId) : null;
    if (raw !== null) {
      const parsed = primaryOperationSchema.shape.result.safeParse(raw);
      if (
        parsed.success &&
        parsed.data &&
        (parsed.data.processExecutionId !== executionId ||
          parsed.data.exitCode !== metadata?.exitCode ||
          parsed.data.failureClassification !== metadata?.failureClassification ||
          (metadata?.sessionId !== undefined && metadata.sessionId !== parsed.data.sessionId))
      )
        return wait("Initial session recovery awaits consistent original result evidence");
      if (parsed.success) result = parsed.data;
      else resultUnavailable = true;
    }
  } catch {
    // Unavailable advisory output cannot veto reconnecting to an independently
    // identified, stopped session. Preserve the artifact, but never replay it.
    resultUnavailable = true;
  }
  const recordedId = metadata?.sessionId ?? result?.sessionId;
  if (
    recordedId !== undefined &&
    (typeof recordedId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(recordedId))
  )
    return wait("Initial session identity evidence is malformed");
  const correlated = sessions.filter(
    (session) =>
      (recordedId !== undefined && session.id === recordedId) ||
      (record.sessionCreationTitle !== undefined && session.title === record.sessionCreationTitle),
  );
  if (
    correlated.length > 1 ||
    correlated.some(
      (session) =>
        session.directory !== options.cwd ||
        (recordedId !== undefined && session.id !== recordedId),
    )
  )
    return wait("Initial session identity has conflicting authoritative matches");
  const candidate = correlated[0];
  if (candidate) {
    if (
      !executionId ||
      !metadata ||
      metadata.treeStopped !== true ||
      metadata.dispatchState !== "dispatched" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(candidate.id)
    )
      return wait("Initial session exists without consistent dispatch provenance");
    if (resultUnavailable)
      logger
        .child({ projectId: record.projectId, cardId })
        .warn(
          "Original planning result is unavailable; diagnostics are preserved and advice will be reacquired in the original session",
        );
    const cached =
      metadata.status === "success" && result?.exitCode === 0
        ? store.writePrimaryResultArtifact(`${cardId}-recovered-planning`, {
            ...result,
            sessionId: candidate.id,
          })
        : undefined;
    persist({
      primarySessionId: candidate.id,
      sessionCreationStatus: "bound",
      ...(cached === undefined ? {} : { sessionCreationResult: cached }),
    });
    logger
      .child({ projectId: record.projectId, cardId })
      .event(
        "Original initial OpenCode session reconciled; resuming the preserved planning checkpoint",
      );
    return "recovered";
  }
  if (sessions.some((session) => session.directory === options.cwd))
    return wait("Unassociated worktree sessions prevent duplicate initial creation");
  if (typeof recordedId === "string") {
    const cached =
      metadata?.status === "success" && result?.exitCode === 0
        ? store.writePrimaryResultArtifact(`${cardId}-recovered-planning`, result)
        : undefined;
    // A known but lost session is not a never-created session. The existing
    // context-reconstruction protocol must authorize any replacement.
    persist({
      primarySessionId: recordedId,
      sessionCreationStatus: "bound",
      ...(cached === undefined ? {} : { sessionCreationResult: cached }),
    });
    return "recovered";
  }
  const dispatched =
    metadata?.dispatchState === "dispatched" && metadata?.status !== "not-dispatched";
  const failedBeforeDispatch =
    metadata?.status === "not-dispatched" ||
    metadata?.status === "spawn-failure" ||
    (!metadata &&
      record.sessionCreationStatus === "ambiguous" &&
      record.sessionCreationTitle !== undefined);
  const outage = metadata?.failureClassification === "dependency-outage";
  const cancelled =
    record.sessionCreationCancelled === true ||
    metadata?.status === "interrupted" ||
    metadata?.cancellationRequested === true;
  const failures =
    (record.sessionCreationFailures ?? 0) +
    ((dispatched || failedBeforeDispatch) && !outage && !cancelled ? 1 : 0);
  if (failures >= OPERATION_RECOVERY_MAX_EXECUTIONS) {
    persist({
      phase: "attention-required",
      sessionCreationStatus: undefined,
      sessionCreationFailures: failures,
      terminalFailure: {
        kind: "implementation",
        outcome: "pending",
        reason:
          "Initial OpenCode session creation exhausted three verified startup failures; work and diagnostics preserved",
      },
    });
    return "failed";
  }
  persist({
    sessionCreationStatus: undefined,
    sessionCreationExecutionId: undefined,
    sessionCreationTitle: undefined,
    sessionCreationResult: undefined,
    sessionCreationCancelled: undefined,
    sessionCreationFailures: failures,
  });
  logger
    .child({ projectId: record.projectId, cardId })
    .event(
      "Initial session dispatch reconciled without a surviving session; safe creation may resume",
    );
  return "recovered";
}
