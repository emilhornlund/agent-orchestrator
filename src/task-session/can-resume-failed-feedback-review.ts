import type { TaskExecutionRecord } from "./task-execution-record.js";
import type { TaskMutationEvent } from "./task-mutation-queue.js";

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
