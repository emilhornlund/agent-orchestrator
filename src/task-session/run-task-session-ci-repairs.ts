import type {
  CiCheckObservation,
  FailedCheckDiagnostic,
} from "../github/github-client.js";
import type { CiCheckEvaluation } from "../github/evaluate-ci-checks.js";
import type { TaskExecutionRecord } from "./task-execution-record.js";
import { canResumeCiReviewRepair } from "./can-resume-ci-review-repair.js";
import { TaskExecutionStore } from "./task-execution-store.js";

export const MAX_CI_REPAIR_ATTEMPTS = 2;

export type TaskSessionCiRepairResult =
  | {
      status: "stopped";
      attempts: number;
      headSha: string;
      reason: "no-change" | "finished-early";
    }
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
  maxAttempts?: number;
  getSourceIdentity?: () => Promise<string>;
  /** The caller verified a CI-owned local review checkpoint before dispatch. */
  resumeReviewRepair?: boolean;
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
  ) => Promise<void | { finishEarly: boolean }>;
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
    (record.phase !== "ci" &&
      !(
        options.resumeReviewRepair === true &&
        record.ciRepair?.activePrimaryOperation !== undefined &&
        record.reviewRepair !== undefined &&
        ["implementation", "validation", "review"].includes(record.phase)
      )) ||
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
  let resumeReviewRepair = options.resumeReviewRepair === true;
  if (
    resumeReviewRepair &&
    !canResumeCiReviewRepair(record, {
      projectId: record.projectId,
      cardId: record.cardId,
      eventId: `ci-repair:${record.cardId}:${options.headSha}`,
      operationKey: `${record.operationKey}:ci:${options.headSha}`,
      kind: "ci-repair",
      status: "active",
      enqueuedAt: record.updatedAt,
    })
  )
    throw new TaskSessionCiRepairError(
      "CI review recovery lacks its completed owning correction",
    );
  // An episode belongs to the durable task operation, not a mutable commit SHA.
  // Publishing a repair changes headSha but must not reset its correction budget.
  const cycleId =
    record.ciRepair?.cycleId ??
    (record.feedbackRemediation === undefined
      ? `${options.operationKey}:ci`
      : `${options.operationKey}:ci:${record.feedbackRemediation.operationId}`);
  const maxAttempts =
    record.ciRepair === undefined
      ? (options.maxAttempts ?? MAX_CI_REPAIR_ATTEMPTS)
      : (record.ciRepair.maxAttempts ?? MAX_CI_REPAIR_ATTEMPTS);
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 0)
    throw new TaskSessionCiRepairError(
      "CI correction limit must be a nonnegative safe integer",
    );
  const episode = {
    cycleId,
    maxAttempts,
    initiatingEventId:
      record.ciRepair?.initiatingEventId ??
      record.feedbackRemediation?.operationId ??
      `${options.operationKey}:initial-publication`,
  };
  if (record.ciRepair?.cycleId !== cycleId) {
    record = updateRecord(options.store, record, {
      retryCounters: { ...record.retryCounters, ci: 0 },
      ciRepair: { ...episode, headSha, status: "active" },
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
          ciRepair: { ...episode, headSha, status: "passed" },
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
      if (active === undefined && completedAttempts >= maxAttempts) {
        updateRecord(options.store, record, {
          phase: "human-feedback",
          ciRepair: { ...episode, headSha, status: "exhausted" },
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
          ...episode,
          headSha,
          status: "active",
          activePrimaryOperation: {
            operationId,
            pass: attempt,
            diagnosticsArtifact,
            ...(options.getSourceIdentity === undefined
              ? {}
              : { sourceIdentity: await options.getSourceIdentity() }),
          },
        },
      });
    }
    try {
      let finishEarly = active?.finishEarly === true;
      if (!resumeReviewRepair) {
        const outcome = await options.repairPrimarySession(
          diagnostics,
          attempt,
          options.expectedPrimarySessionId,
          operationId,
        );
        finishEarly ||= outcome?.finishEarly === true;
      }
      const afterPrimary = options.store.read(options.cardId);
      const reservation = afterPrimary?.ciRepair?.activePrimaryOperation;
      if (!afterPrimary || reservation?.operationId !== operationId)
        throw new TaskSessionCiRepairError(
          "CI primary reservation changed after correction",
        );
      const noChange =
        reservation.sourceIdentity !== undefined &&
        options.getSourceIdentity !== undefined &&
        reservation.sourceIdentity === (await options.getSourceIdentity());
      if (noChange) {
        updateRecord(options.store, afterPrimary, {
          phase: "human-feedback",
          reviewRepair: undefined,
          ciRepair: {
            ...episode,
            headSha,
            status: "stopped",
            stopReason: "no-change",
          },
        });
        return {
          status: "stopped",
          attempts: afterPrimary.retryCounters.ci,
          headSha,
          reason: "no-change",
        };
      }
      if (finishEarly && !reservation.finishEarly)
        updateRecord(options.store, afterPrimary, {
          ciRepair: {
            ...afterPrimary.ciRepair!,
            activePrimaryOperation: { ...reservation, finishEarly: true },
          },
        });
      resumeReviewRepair = false;
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
          ciRepair: { ...episode, headSha, status: "active" },
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
            ...episode,
            headSha,
            status: "active",
          },
        });
      }
      if (finishEarly) {
        const latest = options.store.read(options.cardId)!;
        updateRecord(options.store, latest, {
          phase: "human-feedback",
          ciRepair: {
            ...episode,
            headSha,
            status: "stopped",
            stopReason: "finished-early",
          },
        });
        return {
          status: "stopped",
          attempts: latest.retryCounters.ci,
          headSha,
          reason: "finished-early",
        };
      }
    } catch (error) {
      throw new TaskSessionCiRepairError(
        "CI repair did not complete; PR and task state are preserved",
        { cause: error },
      );
    }
  }
}
