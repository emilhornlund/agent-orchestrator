import { createHash } from "node:crypto";
import type { TaskExecutionRecord } from "./task-execution-record.js";

/** A verified human retry can reuse a head, but not a completed queue identity. */
export function ciRepairEventId(record: TaskExecutionRecord, headSha: string): string {
  const legacy = `ci-repair:${record.cardId}:${headSha}`;
  const trigger =
    record.ciRepair !== undefined
      ? record.ciRepair.initiatingEventId
      : record.feedbackRemediation &&
          ["changed", "no-op"].includes(record.feedbackRemediation.status)
        ? record.feedbackRemediation.operationId
        : undefined;
  return !trigger || trigger === `${record.operationKey}:initial-publication`
    ? legacy
    : `${legacy}:episode:${createHash("sha256").update(trigger).digest("hex").slice(0, 16)}`;
}
