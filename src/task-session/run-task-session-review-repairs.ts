import type { ImplementationReviewResult } from "./implementation-review-result.js";
import type { TaskExecutionRecord } from "./task-execution-record.js";
import { TaskExecutionStore } from "./task-execution-store.js";

export const MAX_REVIEW_REPAIR_ATTEMPTS = 2;

export interface TaskSessionReviewRound {
  review: ImplementationReviewResult;
  contentIdentity: string;
}

export interface RunTaskSessionReviewRepairsOptions {
  store: TaskExecutionStore;
  projectId: string;
  cardId: string;
  operationKey: string;
  expectedPrimarySessionId: string;
  runReview: () => Promise<TaskSessionReviewRound>;
  repair: (
    review: ImplementationReviewResult,
    attempt: number,
  ) => Promise<void>;
  rerunQuality: () => Promise<void>;
  getCurrentContentIdentity: () => Promise<string>;
}

export interface TaskSessionReviewRepairResult extends TaskSessionReviewRound {
  attempts: number;
  record: TaskExecutionRecord;
}

export class TaskSessionReviewRepairError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskSessionReviewRepairError";
  }
}

export class TaskSessionReviewRepairExhaustedError extends Error {
  constructor(public readonly attempts: number) {
    super(`Implementation review remains blocking after ${attempts} repairs`);
    this.name = "TaskSessionReviewRepairExhaustedError";
  }
}

function nextTimestamp(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

function updateRecord(
  store: TaskExecutionStore,
  record: TaskExecutionRecord,
  update: Partial<TaskExecutionRecord>,
): TaskExecutionRecord {
  return store.compareAndSwap(record.cardId, record.revision, {
    ...record,
    ...update,
    revision: record.revision + 1,
    updatedAt: nextTimestamp(record.updatedAt),
  });
}

function assertOwner(
  record: TaskExecutionRecord | null,
  options: RunTaskSessionReviewRepairsOptions,
): asserts record is TaskExecutionRecord {
  if (
    record === null ||
    record.projectId !== options.projectId ||
    record.cardId !== options.cardId ||
    record.operationKey !== options.operationKey ||
    record.primarySessionId !== options.expectedPrimarySessionId ||
    record.phase !== "review"
  ) {
    throw new TaskSessionReviewRepairError(
      "Review repair requires the owned review-phase task and exact primary session",
    );
  }
}

export async function runTaskSessionReviewWithRepairs(
  options: RunTaskSessionReviewRepairsOptions,
): Promise<TaskSessionReviewRepairResult> {
  let record = options.store.read(options.cardId);
  assertOwner(record, options);
  const cycleId = options.operationKey;

  if (record.reviewRepair?.cycleId !== cycleId) {
    updateRecord(options.store, record, {
      retryCounters: { ...record.retryCounters, review: 0 },
      reviewRepair: { cycleId, status: "active" },
    });
  }

  if (record.reviewRepair?.status === "exhausted") {
    throw new TaskSessionReviewRepairExhaustedError(
      record.retryCounters.review,
    );
  }

  for (;;) {
    const round = await options.runReview();
    const currentIdentity = await options.getCurrentContentIdentity();
    if (
      round.contentIdentity !== currentIdentity ||
      round.review.reviewedContentIdentity !== currentIdentity
    ) {
      throw new TaskSessionReviewRepairError(
        "Review result or quality evidence belongs to a stale source snapshot",
      );
    }

    record = options.store.read(options.cardId);
    assertOwner(record, options);

    if (round.review.verdict === "pass") {
      record = updateRecord(options.store, record, {
        reviewRepair: { cycleId, status: "passed" },
      });
      return { ...round, attempts: record.retryCounters.review, record };
    }

    const attempts = record.retryCounters.review;
    if (attempts >= MAX_REVIEW_REPAIR_ATTEMPTS) {
      updateRecord(options.store, record, {
        reviewRepair: { cycleId, status: "exhausted" },
      });
      throw new TaskSessionReviewRepairExhaustedError(
        record.retryCounters.review,
      );
    }

    updateRecord(options.store, record, {
      retryCounters: { ...record.retryCounters, review: attempts + 1 },
      reviewRepair: { cycleId, status: "active" },
    });
    try {
      await options.repair(round.review, attempts + 1);
      await options.rerunQuality();
    } catch (error) {
      throw new TaskSessionReviewRepairError(
        `Review repair attempt ${attempts + 1} did not complete; task state is preserved`,
        { cause: error },
      );
    }
  }
}
