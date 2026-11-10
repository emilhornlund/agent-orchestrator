import type { TaskExecutionRecord } from "./task-execution-record.js";
import type { TaskMutationEvent } from "./task-mutation-queue.js";

/** Select the owning feedback review checkpoint; execution liveness is reconciled separately. */
export function canResumeFeedbackReviewRepair(
  record: TaskExecutionRecord | null,
  active: TaskMutationEvent | null,
): boolean {
  if (
    record === null ||
    active === null ||
    !["implementation", "validation", "review"].includes(record.phase) ||
    record.projectId !== active.projectId ||
    record.cardId !== active.cardId ||
    active.kind !== "feedback" ||
    active.operationKey !== active.eventId ||
    !["active", "failed"].includes(active.status) ||
    record.feedbackRemediation?.status !== "changed" ||
    record.feedbackRemediation.operationId !== active.eventId ||
    record.pullRequest?.headSha === undefined ||
    record.feedbackRemediation.headSha !== record.pullRequest.headSha ||
    record.primarySessionId === undefined ||
    record.sessionCreationStatus !== "bound" ||
    record.reviewRepair === undefined ||
    !["active", "passed", "exhausted"].includes(record.reviewRepair.status)
  )
    return false;

  const repair = record.reviewRepair;
  const reservation = repair.activePrimaryOperation;
  const expectedCycle = `${record.operationKey}:feedback:${active.eventId}`;
  if (
    repair.cycleId !== expectedCycle &&
    !(repair.cycleId === record.operationKey && reservation !== undefined)
  )
    return false;
  if (reservation === undefined)
    return (
      record.phase !== "implementation" &&
      (active.status === "active" ||
        repair.status === "active" ||
        repair.status === "passed")
    );
  const operation = record.primaryOperations?.[reservation.operationId];
  return (
    repair.status === "active" &&
    reservation.pass === record.retryCounters.review &&
    reservation.promptArtifact !== undefined &&
    reservation.operationId ===
      `${record.operationKey}:review:${repair.cycleId}:pass:${reservation.pass}` &&
    (operation === undefined ||
      (operation.id === reservation.operationId &&
        operation.activity === "feedback-review-repair" &&
        (operation.role === undefined || operation.role === "primary")))
  );
}

/** A failed feedback mutation gets one automatic recovery attempt, even across restarts. */
export function canResumeFailedFeedbackReview(
  record: TaskExecutionRecord | null,
  active: TaskMutationEvent | null,
): boolean {
  return (
    record !== null &&
    active !== null &&
    record.phase === "review" &&
    record.reviewRepair?.status === "exhausted" &&
    record.feedbackRemediation?.status === "changed" &&
    record.feedbackRecoveryAttemptEventId !== active.eventId &&
    record.feedbackRemediation.operationId === active.eventId &&
    record.feedbackRemediation.headSha === record.pullRequest?.headSha &&
    record.projectId === active.projectId &&
    record.cardId === active.cardId &&
    active.kind === "feedback" &&
    active.status === "failed"
  );
}
