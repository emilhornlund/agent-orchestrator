import type { ProjectConfig } from "../config/config.js";
import type { CiCheckEvaluation } from "../github/evaluate-ci-checks.js";
import { TaskExecutionStore } from "./task-execution-store.js";
import type {
  TaskExecutionRecord,
  TaskExecutionPhase,
} from "./task-execution-record.js";
import { transitionTaskExecutionRecord } from "./task-execution-transition.js";
import { loadOwnedTaskExecutionRecord } from "./task-execution-ownership.js";
import { assertOwnedTaskWorktreePath } from "./run-task-session-implementation.js";
import { isRetryableGitHubError } from "../github/github-client.js";
import { isRetryableTrelloError } from "../trello/trello-client.js";

export interface TaskSessionRecoverySnapshot {
  primarySessionAccessible:
    "reachable" | "confirmed-absent" | "conflict" | "unknown" | boolean | null;
  worktreeExists: boolean;
  worktreeBranch: string | null;
  worktreeHeadSha: string | null;
  worktreeRebaseActive: boolean;
  trustedCommitSha: string | null;
  verifiedUncommittedPublication?: boolean;
  remoteBranchHeadSha: string | null;
  trelloListId: string;
  pullRequest: {
    number: number;
    url: string;
    headSha: string;
    state: "OPEN" | "CLOSED" | "MERGED";
  } | null;
  ciEvaluation: CiCheckEvaluation | null;
  feedbackHeadSha: string | null;
  uncertainReplyIds: readonly string[];
  reconciledReplyIds: readonly string[];
}

export interface ReconcileTaskSessionOptions {
  project: ProjectConfig;
  cardId: string;
  expectedBranch: string;
  operationKey: string;
  worktreePath: string;
  taskRecordStore: TaskExecutionStore;
  signal?: AbortSignal;
  retryIntervalMs?: number;
  now?: () => number;
  readTerminalPullRequest?: (record: TaskExecutionRecord) => Promise<{
    number: number;
    url: string;
    state: "OPEN" | "CLOSED" | "MERGED";
  } | null>;
  readAuthoritativeSnapshot: (
    record: TaskExecutionRecord,
  ) => Promise<TaskSessionRecoverySnapshot>;
}

export type TaskSessionRecoveryResult =
  | { status: "resume"; phase: TaskExecutionPhase; record: TaskExecutionRecord }
  | { status: "reconstruction-required"; record: TaskExecutionRecord }
  | {
      status: "waiting";
      checkpoint: TaskExecutionPhase;
      reason: string;
      record: TaskExecutionRecord;
    }
  | {
      status: "attention-required";
      reason: string;
      record: TaskExecutionRecord;
    }
  | { status: "terminal-observed"; record: TaskExecutionRecord }
  | { status: "complete"; record: TaskExecutionRecord };

function bumpTimestamp(record: TaskExecutionRecord): string {
  return new Date(
    Math.max(Date.now(), Date.parse(record.updatedAt) + 1),
  ).toISOString();
}

function preserveAttention(
  store: TaskExecutionStore,
  record: TaskExecutionRecord,
  reason: string,
): TaskSessionRecoveryResult {
  if (record.phase === "attention-required") {
    return { status: "attention-required", reason, record };
  }
  if (record.phase === "done") {
    return { status: "attention-required", reason, record };
  }
  const next = transitionTaskExecutionRecord(record, {
    type: "attention-required",
    eventId: `${record.operationKey}:recovery-attention:${record.revision}`,
    projectId: record.projectId,
    cardId: record.cardId,
    operationKey: record.operationKey,
    occurredAt: bumpTimestamp(record),
  });
  const persisted = store.compareAndSwap(record.cardId, record.revision, {
    ...next,
    recoveryWait: undefined,
  });
  return { status: "attention-required", reason, record: persisted };
}

function persistWait(
  store: TaskExecutionStore,
  record: TaskExecutionRecord,
  options: ReconcileTaskSessionOptions,
  reason: string,
  kind: "dependency" | "manual-move" = "dependency",
  patch: Partial<TaskExecutionRecord> = {},
): TaskSessionRecoveryResult {
  const interval = options.retryIntervalMs;
  if (interval === undefined || !Number.isSafeInteger(interval) || interval < 1)
    throw new Error("Recovery wait requires the configured retry interval");
  const now = options.now?.() ?? Date.now();
  const since = record.recoveryWait?.since ?? new Date(now).toISOString();
  const retryAt = new Date(now + interval).toISOString();
  const notificationId = `${record.projectId}/${record.cardId}/${record.operationKey}/${kind}`;
  const next: TaskExecutionRecord = {
    ...record,
    ...patch,
    recoveryWait: {
      kind,
      reason,
      resumePhase:
        record.recoveryWait?.resumePhase ??
        (record.phase as Exclude<
          TaskExecutionPhase,
          "done" | "attention-required"
        >),
      since,
      retryAt,
      attempts: (record.recoveryWait?.attempts ?? 0) + 1,
      notificationId,
    },
    revision: record.revision + 1,
    updatedAt: new Date(now).toISOString(),
  };
  const persisted = store.compareAndSwap(record.cardId, record.revision, next);
  return {
    status: "waiting",
    checkpoint: next.recoveryWait!.resumePhase,
    reason,
    record: persisted,
  };
}

export function persistTaskSessionContextWait(
  store: TaskExecutionStore,
  record: TaskExecutionRecord,
  options: ReconcileTaskSessionOptions,
  reason: string,
): TaskSessionRecoveryResult {
  return persistWait(store, record, options, reason, "dependency", {
    sessionRecovery: {
      ...(record.sessionRecovery ?? {
        originalSessionId: record.primarySessionId ?? "unknown-session",
        status: "inspection-pending" as const,
      }),
      contextAvailability: "unavailable",
      contextAvailabilityReason: reason.slice(0, 1_000),
    },
  });
}

function clearWaitAndResume(
  store: TaskExecutionStore,
  record: TaskExecutionRecord,
): TaskSessionRecoveryResult {
  const recovered = record.recoveryWait
    ? store.compareAndSwap(record.cardId, record.revision, {
        ...record,
        recoveryWait: undefined,
        revision: record.revision + 1,
        updatedAt: bumpTimestamp(record),
      })
    : record;
  return { status: "resume", phase: recovered.phase, record: recovered };
}

function expectedTrelloList(
  project: ProjectConfig,
  phase: TaskExecutionPhase,
): string {
  if (phase === "human-feedback" || phase === "ci")
    return project.trello.reviewListId;
  if (phase === "done") return project.trello.doneListId;
  return project.trello.workingListId;
}

function requiresWorktree(phase: TaskExecutionPhase): boolean {
  return phase !== "attention-required" && phase !== "done";
}

function requiresPullRequest(phase: TaskExecutionPhase): boolean {
  return phase === "ci" || phase === "human-feedback" || phase === "done";
}

function checkObservationIsStale(
  snapshot: TaskSessionRecoverySnapshot,
  expectedHead: string,
): boolean {
  return (
    snapshot.ciEvaluation !== null &&
    snapshot.ciEvaluation.expectedHeadSha !== expectedHead
  );
}

export async function reconcileTaskSession(
  options: ReconcileTaskSessionOptions,
): Promise<TaskSessionRecoveryResult> {
  const { project, cardId, expectedBranch, operationKey, taskRecordStore } =
    options;
  const record = loadOwnedTaskExecutionRecord(taskRecordStore, {
    projectId: project.id,
    cardId,
    expectedBranch,
    operationKey,
  });
  if (
    options.readTerminalPullRequest &&
    record.phase !== "done" &&
    record.pullRequest !== undefined
  ) {
    const terminal = await options.readTerminalPullRequest(record);
    if (
      terminal !== null &&
      terminal.number === record.pullRequest.number &&
      terminal.url === record.pullRequest.url &&
      (terminal.state === "MERGED" || terminal.state === "CLOSED")
    ) {
      // This is only a handoff hint. The existing terminal observer must still
      // verify PR ownership/head continuity and perform the external terminal
      // workflow; local session/worktree checks are not allowed to hide it.
      return { status: "terminal-observed", record };
    }
  }
  if (record.phase === "attention-required") {
    return {
      status: "attention-required",
      reason: "Task was already escalated",
      record,
    };
  }
  if (
    record.recoveryWait &&
    (options.now?.() ?? Date.now()) < Date.parse(record.recoveryWait.retryAt)
  )
    return {
      status: "waiting",
      checkpoint: record.recoveryWait.resumePhase,
      reason: record.recoveryWait.reason,
      record,
    };
  let snapshot: TaskSessionRecoverySnapshot;
  try {
    snapshot = await options.readAuthoritativeSnapshot(record);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const reason = `Authoritative recovery snapshot could not be read: ${error instanceof Error ? error.message : String(error)}`;
    // Only recognized transient provider failures are waits. Git/worktree,
    // malformed response, ancestry and safety failures must not be relabeled
    // as outages; they remain attention checkpoints and fail closed.
    if (isRetryableGitHubError(error) || isRetryableTrelloError(error))
      return persistWait(taskRecordStore, record, options, reason);
    return preserveAttention(taskRecordStore, record, reason);
  }
  const expectedTerminalPr = record.pullRequest;
  if (
    record.phase !== "done" &&
    expectedTerminalPr !== undefined &&
    snapshot.pullRequest !== null &&
    snapshot.pullRequest.number === expectedTerminalPr.number &&
    snapshot.pullRequest.url === expectedTerminalPr.url &&
    (snapshot.pullRequest.state === "MERGED" ||
      snapshot.pullRequest.state === "CLOSED")
  )
    return { status: "terminal-observed", record };
  if (
    record.sessionCreationStatus === "creating" ||
    record.sessionCreationStatus === "ambiguous" ||
    (record.primarySessionId === undefined && record.phase !== "planning")
  ) {
    return preserveAttention(
      taskRecordStore,
      record,
      "Primary session identity is missing or ambiguous",
    );
  }
  if (
    record.setup?.status === "active" ||
    (project.repository.setupCommand !== undefined &&
      record.setup === undefined) ||
    (record.setup !== undefined &&
      record.setup.command !== (project.repository.setupCommand ?? null))
  ) {
    return preserveAttention(
      taskRecordStore,
      record,
      "Repository setup state is missing, changed, or has an uncertain outcome",
    );
  }
  if (snapshot.trelloListId !== expectedTrelloList(project, record.phase)) {
    if (record.phase === "done")
      return preserveAttention(
        taskRecordStore,
        record,
        `Trello card is in unexpected list ${snapshot.trelloListId} for phase ${record.phase}`,
      );
    return persistWait(
      taskRecordStore,
      record,
      options,
      `Trello card is in unexpected list ${snapshot.trelloListId} for phase ${record.phase}`,
      "manual-move",
    );
  }
  if (requiresWorktree(record.phase)) {
    try {
      assertOwnedTaskWorktreePath(project, options.worktreePath);
    } catch (error) {
      return preserveAttention(
        taskRecordStore,
        record,
        `Owned worktree is unsafe: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      !snapshot.worktreeExists ||
      snapshot.worktreeBranch !== expectedBranch ||
      snapshot.worktreeRebaseActive
    ) {
      return preserveAttention(
        taskRecordStore,
        record,
        "Owned worktree is missing, on the wrong branch, or has an active rebase",
      );
    }
  }
  if (
    snapshot.trustedCommitSha !== null &&
    snapshot.worktreeHeadSha !== snapshot.trustedCommitSha
  ) {
    return preserveAttention(
      taskRecordStore,
      record,
      "Worktree HEAD does not match the persisted trusted commit",
    );
  }
  if (record.phase === "publication") {
    if (snapshot.pullRequest !== null && record.pullRequest === undefined) {
      return preserveAttention(
        taskRecordStore,
        record,
        "A pull request exists but its identity was not persisted; refusing to guess publication ownership",
      );
    }
    if (
      record.pullRequest !== undefined &&
      (snapshot.pullRequest === null ||
        snapshot.pullRequest.number !== record.pullRequest.number ||
        snapshot.pullRequest.url !== record.pullRequest.url ||
        snapshot.pullRequest.headSha !== record.pullRequest.headSha)
    ) {
      return preserveAttention(
        taskRecordStore,
        record,
        "Partially published pull request does not match the persisted identity",
      );
    }
    const uncommitted =
      (record.validationRepair?.status === "exhausted" ||
        record.reviewUnavailable !== undefined) &&
      record.reviewRepair?.finalReview === undefined &&
      snapshot.verifiedUncommittedPublication === true &&
      snapshot.trustedCommitSha === null &&
      snapshot.remoteBranchHeadSha === null &&
      snapshot.pullRequest === null &&
      record.pullRequest === undefined;
    if (
      (!uncommitted && snapshot.trustedCommitSha === null) ||
      (!uncommitted &&
        snapshot.worktreeHeadSha !== snapshot.trustedCommitSha) ||
      (snapshot.remoteBranchHeadSha !== null &&
        snapshot.remoteBranchHeadSha !== snapshot.trustedCommitSha)
    ) {
      return preserveAttention(
        taskRecordStore,
        record,
        "Partially published task has no unambiguous trusted commit/remote state",
      );
    }
    // Publication verification is one checkpoint, not an escape hatch from
    // the common primary-session recovery gate below.
  }
  if (requiresPullRequest(record.phase)) {
    const expectedPr = record.pullRequest;
    const actualPr = snapshot.pullRequest;
    if (
      expectedPr === undefined ||
      actualPr === null ||
      expectedPr.number !== actualPr.number ||
      expectedPr.url !== actualPr.url ||
      expectedPr.headSha === undefined ||
      expectedPr.headSha !== actualPr.headSha
    ) {
      return preserveAttention(
        taskRecordStore,
        record,
        "Persisted and authoritative pull request identity/head are ambiguous",
      );
    }
    if (snapshot.trustedCommitSha !== expectedPr.headSha) {
      return preserveAttention(
        taskRecordStore,
        record,
        "PR head is not backed by matching trusted commit state",
      );
    }
    if (record.phase === "done" && actualPr.state !== "MERGED") {
      return preserveAttention(
        taskRecordStore,
        record,
        "Done task does not have an authoritatively merged pull request",
      );
    }
    if (
      (record.phase === "ci" || record.phase === "human-feedback") &&
      actualPr.state !== "OPEN"
    ) {
      return preserveAttention(
        taskRecordStore,
        record,
        "Active pull request is not open",
      );
    }
    if (
      record.phase === "ci" &&
      (snapshot.ciEvaluation === null ||
        checkObservationIsStale(snapshot, expectedPr.headSha))
    ) {
      return preserveAttention(
        taskRecordStore,
        record,
        "CI snapshot is missing or belongs to a different PR head",
      );
    }
    if (
      record.phase === "human-feedback" &&
      snapshot.feedbackHeadSha !== expectedPr.headSha
    ) {
      return preserveAttention(
        taskRecordStore,
        record,
        "Feedback snapshot is missing or belongs to a different PR head",
      );
    }
  }
  const uncertainReplies = new Set(snapshot.uncertainReplyIds);
  for (const replyId of snapshot.reconciledReplyIds)
    uncertainReplies.delete(replyId);
  if (uncertainReplies.size > 0) {
    return preserveAttention(
      taskRecordStore,
      record,
      `Feedback reply outcome remains ambiguous: ${[...uncertainReplies].join(", ")}`,
    );
  }
  if (record.phase === "done") return { status: "complete", record };
  if (record.sessionRecovery?.status === "reconstruction-blocked")
    return preserveAttention(
      taskRecordStore,
      record,
      "Primary session reconstruction failed its read-only verification; manual recovery is required",
    );
  if (record.sessionRecovery?.status === "reconstruction-process-failed")
    return persistWait(
      taskRecordStore,
      record,
      options,
      "Primary reconstruction process failed after binding; awaiting approved retry policy",
    );
  if (
    snapshot.primarySessionAccessible === "conflict" ||
    snapshot.primarySessionAccessible === false
  )
    return preserveAttention(
      taskRecordStore,
      record,
      "Bound primary session identity conflicts with the task worktree",
    );
  if (
    snapshot.primarySessionAccessible === null ||
    snapshot.primarySessionAccessible === "unknown"
  )
    return persistWait(
      taskRecordStore,
      record,
      options,
      "Bound primary session accessibility is unknown",
    );
  if (
    record.sessionRecovery?.status === "replacement-creating" ||
    record.sessionRecovery?.status === "replacement-ambiguous"
  )
    return persistWait(
      taskRecordStore,
      record,
      options,
      "Primary replacement creation outcome is ambiguous; refusing another dispatch",
    );
  if (record.sessionRecovery?.contextAvailability === "unavailable")
    return { status: "reconstruction-required", record };
  if (
    snapshot.primarySessionAccessible === "confirmed-absent" ||
    record.sessionRecovery?.status === "replacement-bound"
  )
    return { status: "reconstruction-required", record };
  if (
    record.sessionRecovery !== undefined &&
    record.sessionRecovery.status !== "reconstruction-verified"
  )
    return persistWait(
      taskRecordStore,
      record,
      options,
      "Primary session reconstruction is pending verification",
    );
  return clearWaitAndResume(taskRecordStore, record);
}
