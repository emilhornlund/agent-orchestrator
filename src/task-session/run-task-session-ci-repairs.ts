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
    operationId: string,
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
  // An episode belongs to the durable task operation, not a mutable commit SHA.
  // Publishing a repair changes headSha but must not reset its correction budget.
  const cycleId = record.ciRepair?.cycleId ?? `${options.operationKey}:ci`;
  if (record.ciRepair?.cycleId !== cycleId) {
    record = updateRecord(options.store, record, {
      retryCounters: { ...record.retryCounters, ci: 0 },
      ciRepair: { cycleId, headSha, status: "active" },
    });
  }

  for (;;) {
    const active = record.ciRepair?.activePrimaryOperation;
    const completedAttempts = record.retryCounters.ci;
    const attempt = active?.pass ?? completedAttempts + 1;
    let diagnostics: FailedCheckDiagnostic[];
    if (active !== undefined) {
      if (active.diagnosticsArtifact === undefined)
        throw new TaskSessionCiRepairError(
          "Reserved CI repair lacks persisted diagnostics; preserving the reservation",
        );
      const storedDiagnostics: unknown =
        options.store.readPrimaryResultArtifact({
          reference: active.diagnosticsArtifact.reference as `sha256:${string}`,
          bytes: active.diagnosticsArtifact.bytes,
          ...(active.diagnosticsArtifact.path === undefined
            ? {}
            : { path: active.diagnosticsArtifact.path }),
        });
      if (
        !Array.isArray(storedDiagnostics) ||
        !storedDiagnostics.every(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            "name" in item &&
            typeof item.name === "string" &&
            "headSha" in item &&
            item.headSha === headSha &&
            "logUrl" in item &&
            (item.logUrl === null || typeof item.logUrl === "string") &&
            "available" in item &&
            typeof item.available === "boolean" &&
            "diagnostic" in item &&
            typeof item.diagnostic === "string" &&
            (!("checkRunId" in item) || typeof item.checkRunId === "number"),
        )
      )
        throw new TaskSessionCiRepairError(
          "Persisted CI repair diagnostics are invalid; preserving the reservation",
        );
      diagnostics = storedDiagnostics as FailedCheckDiagnostic[];
    } else {
      const evaluation = await options.observeChecks(headSha);
      if (evaluation.expectedHeadSha !== headSha)
        throw new TaskSessionCiRepairError(
          "Complete CI evaluation belongs to a different PR head",
        );
      if (evaluation.status === "passed") {
        record = ownerRecord(options, record.pullRequest?.headSha);
        updateRecord(options.store, record, {
          ciRepair: { cycleId, headSha, status: "passed" },
        });
        return { status: "passed", attempts: record.retryCounters.ci, headSha };
      }
      if (evaluation.status === "waiting" || evaluation.status === "uncertain")
        return {
          status: "waiting",
          attempts: record.retryCounters.ci,
          headSha,
          evaluation,
        };
      const failures = evaluation.failures;
      if (failures.length === 0)
        throw new TaskSessionCiRepairError(
          "Failed CI evaluation did not include any terminal check failures",
        );
      if (active === undefined && completedAttempts >= MAX_CI_REPAIR_ATTEMPTS) {
        updateRecord(options.store, record, {
          phase: "attention-required",
          ciRepair: { cycleId, headSha, status: "exhausted" },
        });
        return {
          status: "exhausted",
          attempts: completedAttempts,
          headSha,
          failures,
        };
      }
      diagnostics = await options.collectDiagnostics(headSha, failures);
    }
    const operationId = active?.operationId ?? `${cycleId}:pass:${attempt}`;
    if (active === undefined) {
      const diagnosticsArtifact = options.store.writePrimaryResultArtifact(
        `${operationId}:diagnostics`,
        diagnostics,
      );
      record = updateRecord(options.store, record, {
        retryCounters: { ...record.retryCounters, ci: attempt },
        ciRepair: {
          cycleId,
          headSha,
          status: "active",
          activePrimaryOperation: {
            operationId,
            pass: attempt,
            diagnosticsArtifact,
          },
        },
      });
    }
    try {
      await options.repairPrimarySession(
        diagnostics,
        attempt,
        options.expectedPrimarySessionId,
        operationId,
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
      const afterCheckpoint = options.store.read(options.cardId);
      if (
        afterCheckpoint?.ciRepair?.activePrimaryOperation?.operationId ===
        operationId
      ) {
        record = updateRecord(options.store, afterCheckpoint, {
          ciRepair: {
            cycleId,
            headSha,
            status: "active",
          },
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
