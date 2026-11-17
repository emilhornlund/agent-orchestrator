import type { RunRecord } from "./run-record.js";
import { isConclusiveOperationResolution } from "./run-record.js";
import type { TaskExecutionRecord } from "./task-execution-record.js";

export const PUBLICATION_WORKTREE_CHANGES_ERROR =
  "Publication worktree contains changes not represented by the trusted commit";

/** Completed review authorizes inspecting the pre-commit source, not trusting
 * an arbitrary dirty tree. The production snapshot must still verify its exact
 * content identity, branch, ancestry, absent remote effects and Git state. */
export function hasCompletedPublicationReview(record: TaskExecutionRecord): boolean {
  const repair = record.reviewRepair;
  const review = repair?.finalReview;
  return (
    repair !== undefined &&
    review !== undefined &&
    repair.cycleId === record.operationKey &&
    ["passed", "exhausted"].includes(repair.status) &&
    repair.activePrimaryOperation === undefined &&
    record.validationRepair?.activePrimaryOperation === undefined &&
    !Object.values(record.primaryOperations ?? {}).some(
      (operation) =>
        operation &&
        !["completed", "cancelled"].includes(operation.status) &&
        !(operation.status === "failed" && operation.retrySafe === true),
    ) &&
    review.projectId === record.projectId &&
    review.cardId === record.cardId &&
    record.pullRequest === undefined &&
    record.externalRecovery === undefined &&
    record.terminalFailure === undefined
  );
}

export function isUncommittedPublicationCandidate(record: TaskExecutionRecord): boolean {
  return (
    record.phase === "publication" &&
    (((record.validationRepair?.status === "exhausted" || record.reviewUnavailable !== undefined) &&
      record.reviewRepair?.finalReview === undefined) ||
      hasCompletedPublicationReview(record))
  );
}

/** Recheck only the specific older false-positive fence. This grants read-only
 * reconciliation; source/remote/session/queue proofs still precede resumption. */
export function canRecheckReviewedPublication(
  run: RunRecord | null,
  record: TaskExecutionRecord,
): boolean {
  if (
    record.phase !== "attention-required" ||
    record.recoveryAttentionReason !==
      `Authoritative recovery snapshot could not be read: ${PUBLICATION_WORKTREE_CHANGES_ERROR}` ||
    !hasCompletedPublicationReview(record) ||
    !record.primarySessionId ||
    record.sessionCreationStatus !== "bound" ||
    record.ciRepair?.activePrimaryOperation ||
    record.feedbackRemediation ||
    (record.sessionRecovery && record.sessionRecovery.status !== "reconstruction-verified")
  )
    return false;
  if (!run) return true; // Standalone legacy projection still requires the complete snapshot.
  return (
    run.lifecycle === "waiting" &&
    run.checkpoint === "publication" &&
    run.taskKind === "implementation" &&
    run.publicationState === "none" &&
    run.projectId === record.projectId &&
    run.cardId === record.cardId &&
    run.operation.id === record.operationKey &&
    run.operation.kind === "attention-required" &&
    run.wait.reason === "task-attention-required" &&
    run.sessions.primary === record.primarySessionId &&
    run.pendingOperations.every(isConclusiveOperationResolution)
  );
}
