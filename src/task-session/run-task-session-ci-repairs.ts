import type {
  FailedCheckDiagnostic,
  RequiredCheckObservation,
} from "../github/github-client.js";
import type { TaskExecutionRecord } from "./task-execution-record.js";
import { TaskExecutionStore } from "./task-execution-store.js";

export const MAX_CI_REPAIR_ATTEMPTS = 2;

export type TaskSessionCiRepairResult =
  | { status: "passed"; attempts: number; headSha: string }
  | {
      status: "waiting";
      attempts: number;
      headSha: string;
      checks: RequiredCheckObservation[];
    }
  | {
      status: "exhausted";
      attempts: number;
      headSha: string;
      checks: RequiredCheckObservation[];
    };

export interface RunTaskSessionCiRepairsOptions {
  store: TaskExecutionStore;
  projectId: string;
  cardId: string;
  operationKey: string;
  expectedPrimarySessionId: string;
  headSha: string;
  observeChecks: (headSha: string) => Promise<RequiredCheckObservation[]>;
  collectDiagnostics: (
    headSha: string,
    checks: readonly RequiredCheckObservation[],
  ) => Promise<FailedCheckDiagnostic[]>;
  repairPrimarySession: (
    diagnostics: readonly FailedCheckDiagnostic[],
    attempt: number,
    primarySessionId: string,
  ) => Promise<void>;
  rerunLocalGatesAndReview: () => Promise<void>;
  publishSamePullRequest: () => Promise<string>;
}

export class TaskSessionCiRepairError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskSessionCiRepairError";
  }
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
    updatedAt: new Date(
      Math.max(Date.now(), Date.parse(record.updatedAt) + 1),
    ).toISOString(),
  });
}

function ownerRecord(
  options: RunTaskSessionCiRepairsOptions,
  expectedHeadSha = options.headSha,
): TaskExecutionRecord {
  const record = options.store.read(options.cardId);
  if (
    record === null ||
    record.projectId !== options.projectId ||
    record.operationKey !== options.operationKey ||
    record.phase !== "ci" ||
    record.primarySessionId !== options.expectedPrimarySessionId ||
    record.pullRequest?.headSha !== expectedHeadSha
  ) {
    throw new TaskSessionCiRepairError(
      "CI repair ownership, phase, session, or PR head does not match",
    );
  }
  return record;
}

function allSucceeded(checks: readonly RequiredCheckObservation[]): boolean {
  return (
    checks.length > 0 && checks.every((check) => check.status === "succeeded")
  );
}

export async function runTaskSessionCiRepairs(
  options: RunTaskSessionCiRepairsOptions,
): Promise<TaskSessionCiRepairResult> {
  let record = ownerRecord(options);
  let headSha = options.headSha;
  const cycleId = `${options.operationKey}:${headSha}`;
  if (record.ciRepair?.cycleId !== cycleId) {
    record = updateRecord(options.store, record, {
      retryCounters: { ...record.retryCounters, ci: 0 },
      ciRepair: { cycleId, headSha, status: "active" },
    });
  }

  for (;;) {
    const checks = await options.observeChecks(headSha);
    if (checks.some((check) => check.headSha !== headSha)) {
      throw new TaskSessionCiRepairError(
        "Required check observation belongs to a stale PR head",
      );
    }
    if (allSucceeded(checks)) {
      record = ownerRecord(options, record.pullRequest?.headSha);
      updateRecord(options.store, record, {
        ciRepair: { cycleId, headSha, status: "passed" },
      });
      return { status: "passed", attempts: record.retryCounters.ci, headSha };
    }
    const failed = checks.some((check) => check.status === "failed");
    if (!failed) {
      return {
        status: "waiting",
        attempts: record.retryCounters.ci,
        headSha,
        checks,
      };
    }
    const attempt = record.retryCounters.ci;
    if (attempt >= MAX_CI_REPAIR_ATTEMPTS) {
      updateRecord(options.store, record, {
        phase: "attention-required",
        ciRepair: { cycleId, headSha, status: "exhausted" },
      });
      return { status: "exhausted", attempts: attempt, headSha, checks };
    }
    const diagnostics = await options.collectDiagnostics(headSha, checks);
    record = updateRecord(options.store, record, {
      retryCounters: { ...record.retryCounters, ci: attempt + 1 },
      ciRepair: { cycleId, headSha, status: "active" },
    });
    try {
      await options.repairPrimarySession(
        diagnostics,
        attempt + 1,
        options.expectedPrimarySessionId,
      );
      await options.rerunLocalGatesAndReview();
      headSha = await options.publishSamePullRequest();
      if (
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(headSha) ||
        headSha === record.ciRepair?.headSha
      ) {
        throw new Error(
          "CI repair publication did not produce a new valid PR head",
        );
      }
      record = ownerRecord(options, record.pullRequest?.headSha);
      record = updateRecord(options.store, record, {
        pullRequest: { ...record.pullRequest!, headSha },
        ciRepair: { cycleId, headSha, status: "active" },
      });
    } catch (error) {
      throw new TaskSessionCiRepairError(
        "CI repair did not complete; PR and task state are preserved",
        { cause: error },
      );
    }
  }
}
