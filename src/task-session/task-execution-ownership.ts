import { TaskExecutionStore } from "./task-execution-store.js";
import type { TaskExecutionRecord } from "./task-execution-record.js";

export interface TaskExecutionOwnershipRequest {
  projectId: string;
  cardId: string;
  expectedBranch: string;
  operationKey: string;
}

export class TaskExecutionOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskExecutionOwnershipError";
  }
}

export function loadOwnedTaskExecutionRecord(
  store: TaskExecutionStore,
  requested: TaskExecutionOwnershipRequest,
): TaskExecutionRecord {
  const record = store.read(requested.cardId);

  if (record === null) {
    throw new TaskExecutionOwnershipError(
      `No task execution record exists for ${requested.projectId}/${requested.cardId}`,
    );
  }

  if (
    record.projectId !== requested.projectId ||
    record.cardId !== requested.cardId
  ) {
    throw new TaskExecutionOwnershipError(
      `Task execution record owner does not match ${requested.projectId}/${requested.cardId}`,
    );
  }

  if (record.expectedBranch !== requested.expectedBranch) {
    throw new TaskExecutionOwnershipError(
      `Task execution record branch does not match ${requested.expectedBranch}`,
    );
  }

  if (record.operationKey !== requested.operationKey) {
    throw new TaskExecutionOwnershipError(
      `Task execution record operation does not match ${requested.operationKey}`,
    );
  }

  return record;
}
