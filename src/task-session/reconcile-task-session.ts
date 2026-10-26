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

export interface TaskSessionRecoverySnapshot {
  primarySessionAccessible: boolean | null;
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
  readAuthoritativeSnapshot: (
    record: TaskExecutionRecord,
  ) => Promise<TaskSessionRecoverySnapshot>;
}

export type TaskSessionRecoveryResult =
  | { status: "resume"; phase: TaskExecutionPhase; record: TaskExecutionRecord }
  | {
      status: "attention-required";
      reason: string;
      record: TaskExecutionRecord;
    }
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
  const persisted = store.compareAndSwap(record.cardId, record.revision, next);
  return { status: "attention-required", reason, record: persisted };
}

function expectedTrelloList(
  project: ProjectConfig,
  phase: TaskExecutionPhase,
): string {
  if (phase === "human-feedback") return project.trello.reviewListId;
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
  if (record.phase === "attention-required") {
    return {
      status: "attention-required",
      reason: "Task was already escalated",
      record,
    };
  }
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
  let snapshot: TaskSessionRecoverySnapshot;
  try {
    snapshot = await options.readAuthoritativeSnapshot(record);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return preserveAttention(
      taskRecordStore,
      record,
      `Authoritative recovery snapshot could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    record.primarySessionId !== undefined &&
    record.phase !== "done" &&
    snapshot.primarySessionAccessible !== true
  ) {
    return preserveAttention(
      taskRecordStore,
      record,
      "Bound primary session is inaccessible or its state is unknown",
    );
  }
  if (snapshot.trelloListId !== expectedTrelloList(project, record.phase)) {
    return preserveAttention(
      taskRecordStore,
      record,
      `Trello card is in unexpected list ${snapshot.trelloListId} for phase ${record.phase}`,
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
      record.validationRepair?.status === "exhausted" &&
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
    return { status: "resume", phase: record.phase, record };
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
  return { status: "resume", phase: record.phase, record };
}
