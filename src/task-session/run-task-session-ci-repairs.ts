import type {
  CiCheckObservation,
  FailedCheckDiagnostic,
} from "../github/github-client.js";
import type { CiCheckEvaluation } from "../github/evaluate-ci-checks.js";
import type { TaskExecutionRecord } from "./task-execution-record.js";
import { TaskExecutionStore } from "./task-execution-store.js";

export const MAX_CI_REPAIR_ATTEMPTS = 2;

export type TaskSessionCiRepairResult =
  | { status: "passed"; attempts: number; headSha: string }
  | {
      status: "waiting";
      attempts: number;
      headSha: string;
      evaluation: CiCheckEvaluation;
    }
  | {
      status: "exhausted";
      attempts: number;
      headSha: string;
      failures: CiCheckObservation[];
    };

export interface RunTaskSessionCiRepairsOptions {
  store: TaskExecutionStore;
  projectId: string;
  cardId: string;
  operationKey: string;
  expectedPrimarySessionId: string;
  headSha: string;
  observeChecks: (headSha: string) => Promise<CiCheckEvaluation>;
  collectDiagnostics: (
    headSha: string,
    failures: readonly CiCheckObservation[],
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
    const evaluation = await options.observeChecks(headSha);
    if (evaluation.expectedHeadSha !== headSha) {
      throw new TaskSessionCiRepairError(
        "Complete CI evaluation belongs to a different PR head",
      );
    }
    if (evaluation.status === "passed") {
      record = ownerRecord(options, record.pullRequest?.headSha);
      updateRecord(options.store, record, {
        ciRepair: { cycleId, headSha, status: "passed" },
      });
      return { status: "passed", attempts: record.retryCounters.ci, headSha };
    }
    if (evaluation.status === "waiting" || evaluation.status === "uncertain") {
      return {
        status: "waiting",
        attempts: record.retryCounters.ci,
        headSha,
        evaluation,
      };
    }
    const failures = evaluation.failures;
    if (failures.length === 0)
      throw new TaskSessionCiRepairError(
        "Failed CI evaluation did not include any terminal check failures",
      );
    const attempt = record.retryCounters.ci;
    if (attempt >= MAX_CI_REPAIR_ATTEMPTS) {
      updateRecord(options.store, record, {
        phase: "attention-required",
        ciRepair: { cycleId, headSha, status: "exhausted" },
      });
      return { status: "exhausted", attempts: attempt, headSha, failures };
    }
    const diagnostics = await options.collectDiagnostics(headSha, failures);
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
      const latest = options.store.read(options.cardId);
      if (
        latest === null ||
        latest.projectId !== options.projectId ||
        latest.cardId !== options.cardId ||
        latest.operationKey !== options.operationKey ||
        latest.primarySessionId !== options.expectedPrimarySessionId ||
        latest.phase !== "ci"
      ) {
        throw new TaskSessionCiRepairError(
          "CI repair publication changed task ownership or phase unexpectedly",
        );
      }
      if (latest.pullRequest?.headSha === headSha) {
        // The publication operation may atomically persist publication-completed
        // with the observed head before returning to this repair coordinator.
        record = latest;
      } else {
        record = ownerRecord(options, latest.pullRequest?.headSha);
        record = updateRecord(options.store, record, {
          pullRequest: { ...record.pullRequest!, headSha },
          ciRepair: { cycleId, headSha, status: "active" },
          reviewObservation: undefined,
        });
      }
    } catch (error) {
      throw new TaskSessionCiRepairError(
        "CI repair did not complete; PR and task state are preserved",
        { cause: error },
      );
    }
  }
}
