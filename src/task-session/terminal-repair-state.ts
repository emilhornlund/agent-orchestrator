import type { TaskExecutionRecord } from "./task-execution-record.js";

export function hasInterruptedRepairs(record: TaskExecutionRecord): boolean {
  return (
    record.validationRepair?.status === "active" ||
    record.validationRepair?.activePrimaryOperation !== undefined ||
    record.reviewRepair?.status === "active" ||
    record.reviewRepair?.activePrimaryOperation !== undefined ||
    record.ciRepair?.status === "active" ||
    record.ciRepair?.activePrimaryOperation !== undefined ||
    record.feedbackRemediation?.status === "active"
  );
}

/** Terminal PR preparation has verified stopped execution and retained the full
 * interrupted record. Retire only live scheduling fields; completed evidence,
 * primary-operation history, budgets and worktree contents are preserved. */
export function retireTerminalRepairs(record: TaskExecutionRecord): TaskExecutionRecord {
  return {
    ...record,
    ...(record.validationRepair?.status === "active" ||
    record.validationRepair?.activePrimaryOperation
      ? { validationRepair: undefined }
      : {}),
    ...(record.reviewRepair?.status === "active" || record.reviewRepair?.activePrimaryOperation
      ? { reviewRepair: undefined }
      : {}),
    ...(record.ciRepair?.status === "active" || record.ciRepair?.activePrimaryOperation
      ? { ciRepair: undefined }
      : {}),
    ...(record.feedbackRemediation?.status === "active" ? { feedbackRemediation: undefined } : {}),
  };
}
