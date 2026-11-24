import { createHash } from "node:crypto";
import type { TaskExecutionRecord } from "./task-execution-record.js";
import type { CiCheckEvaluation } from "../github/evaluate-ci-checks.js";

/** An external SHA alone does not renew a stopped episode. A verified failed
 * check absent from the prior failure set can establish a distinct trigger. */
export function ciRepairEligibleForExternalHead(
  record: TaskExecutionRecord,
  evaluation: CiCheckEvaluation,
): boolean {
  const baseline = record.externalHeadAdoption?.stoppedCiFailures;
  if (
    evaluation.status !== "failed" ||
    baseline === undefined ||
    record.ciRepair?.status === "active" ||
    (record.feedbackRemediation && ["changed", "no-op"].includes(record.feedbackRemediation.status))
  )
    return true;
  return (
    baseline !== null &&
    evaluation.failures.some(
      (check) => !baseline.includes(check.source === "check-run" ? check.name : check.context),
    )
  );
}

/** A verified human retry can reuse a head, but not a completed queue identity. */
export function ciRepairEventId(record: TaskExecutionRecord, headSha: string): string {
  const legacy = `ci-repair:${record.cardId}:${headSha}`;
  const trigger =
    record.ciRepair !== undefined
      ? record.ciRepair.initiatingEventId
      : record.feedbackRemediation &&
          ["changed", "no-op"].includes(record.feedbackRemediation.status)
        ? record.feedbackRemediation.operationId
        : record.externalHeadAdoption?.eventId;
  return !trigger || trigger === `${record.operationKey}:initial-publication`
    ? legacy
    : `${legacy}:episode:${createHash("sha256").update(trigger).digest("hex").slice(0, 16)}`;
}
