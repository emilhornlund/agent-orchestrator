import type { TaskExecutionRecord } from "./task-execution-record.js";
import type { TaskMutationEvent } from "./task-mutation-queue.js";
import { ciRepairEventId } from "./ci-repair-event-id.js";

/** Route local review of an already completed CI correction back to its owner. */
export function canResumeCiReviewRepair(
  record: TaskExecutionRecord | null,
  event: TaskMutationEvent | null,
): boolean {
  if (
    record === null ||
    event === null ||
    !["implementation", "validation", "review"].includes(record.phase) ||
    record.primarySessionId === undefined ||
    record.sessionCreationStatus !== "bound" ||
    record.projectId !== event.projectId ||
    record.cardId !== event.cardId ||
    event.kind !== "ci-repair" ||
    !["active", "failed"].includes(event.status) ||
    record.pullRequest?.headSha === undefined ||
    event.eventId !== ciRepairEventId(record, record.pullRequest.headSha) ||
    event.operationKey !== `${record.operationKey}:ci:${record.pullRequest.headSha}` ||
    record.ciRepair?.status !== "active" ||
    record.ciRepair.headSha !== record.pullRequest.headSha ||
    record.ciRepair.activePrimaryOperation === undefined ||
    record.reviewRepair === undefined ||
    !["active", "passed", "exhausted"].includes(record.reviewRepair.status)
  )
    return false;
  const ci = record.ciRepair.activePrimaryOperation;
  const completedCi = record.primaryOperations?.[ci.operationId];
  if (
    ci.operationId !== `${record.ciRepair.cycleId}:pass:${ci.pass}` ||
    ci.pass !== record.retryCounters.ci ||
    completedCi?.id !== ci.operationId ||
    completedCi.status !== "completed" ||
    completedCi.activity !== "ci-correction" ||
    (completedCi.role !== undefined && completedCi.role !== "primary")
  )
    return false;
  const repair = record.reviewRepair;
  if (
    repair.cycleId !== `${record.operationKey}:ci-review:${record.ciRepair.cycleId}` &&
    !(repair.cycleId === record.operationKey && repair.activePrimaryOperation !== undefined)
  )
    return false;
  const reservation = repair.activePrimaryOperation;
  if (reservation === undefined)
    return (
      record.phase !== "implementation" && (event.status === "active" || repair.status === "passed")
    );
  const primary = record.primaryOperations?.[reservation.operationId];
  return (
    repair.status === "active" &&
    reservation.promptArtifact !== undefined &&
    reservation.pass === record.retryCounters.review &&
    reservation.operationId ===
      `${record.operationKey}:review:${repair.cycleId}:pass:${reservation.pass}` &&
    (primary === undefined ||
      (primary.id === reservation.operationId &&
        primary.activity === "review-correction" &&
        (primary.role === undefined || primary.role === "primary")))
  );
}
