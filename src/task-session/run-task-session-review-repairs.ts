import { createHash } from "node:crypto";
import type {
  ImplementationReviewResult,
  PrimaryReviewDispositionReport,
} from "./implementation-review-result.js";
import type { TaskExecutionRecord } from "./task-execution-record.js";
import { transitionTaskExecutionRecord } from "./task-execution-transition.js";
import { logger } from "../logging/logger.js";
import { TaskExecutionStore } from "./task-execution-store.js";
import { findPrimaryRecoveryError } from "./persist-primary-operation-recovery.js";
import { extractOpenCodeTextOutput } from "../opencode/opencode-client.js";
import { REVIEW_REPAIR_FINISHED_EARLY_MARKER } from "../opencode/build-task-session-review-repair-prompt.js";
import { parsePrimaryReviewDispositionReport } from "./implementation-review-result.js";

type TrackedFinding = NonNullable<
  NonNullable<TaskExecutionRecord["reviewRepair"]>["findings"]
>[number];

export interface TaskSessionReviewRound {
  review: ImplementationReviewResult;
  contentIdentity: string;
  previousFindings?: readonly {
    id: string;
    sourceContentIdentity?: string | undefined;
    sourceIdentities: readonly string[];
    status: "unresolved" | "resolved" | "superseded";
  }[];
}

/** Carry the same CI episode's review history across its next primary correction. */
export function carryReviewRepairIntoCiCorrection(
  reviewRepair: TaskExecutionRecord["reviewRepair"],
  ciReviewCycleId: string,
): TaskExecutionRecord["reviewRepair"] {
  if (
    reviewRepair === undefined ||
    reviewRepair.cycleId !== ciReviewCycleId ||
    reviewRepair.activePrimaryOperation !== undefined
  )
    return undefined;
  return reviewRepair;
}

/** Reuses a precomputed first round once; all later rounds must read current source. */
export function createReviewRoundRunner(
  initialRound: TaskSessionReviewRound | undefined,
  runFreshReview: (previousFindings: readonly TrackedFinding[]) => Promise<TaskSessionReviewRound>,
): (previousFindings: readonly TrackedFinding[]) => Promise<TaskSessionReviewRound> {
  let pendingInitialRound = initialRound;
  return async (previousFindings) => {
    const cached = pendingInitialRound;
    pendingInitialRound = undefined;
    return cached ?? runFreshReview(previousFindings);
  };
}

export interface RunTaskSessionReviewRepairsOptions {
  store: TaskExecutionStore;
  projectId: string;
  cardId: string;
  operationKey: string;
  reviewCycleId?: string;
  expectedPrimarySessionId: string;
  runReview: (previousFindings: readonly TrackedFinding[]) => Promise<TaskSessionReviewRound>;
  repair: (
    review: ImplementationReviewResult,
    attempt: number,
    operationId: string,
    persistedPrompt?: string,
  ) => Promise<
    | void
    | PrimaryReviewDispositionReport
    | {
        dispositions?: PrimaryReviewDispositionReport;
        finishedEarly?: boolean;
      }
    | undefined
  >;
  buildRepairPrompt?: (
    review: ImplementationReviewResult,
    attempt: number,
  ) => string | Promise<string>;
  rerunQuality: () => Promise<void>;
  getCurrentContentIdentity: () => Promise<string>;
  maxAttempts: number;
}

interface ReviewRepairOutcome {
  dispositions?: PrimaryReviewDispositionReport;
  finishedEarly: boolean;
}

function normalizeRepairOutcome(
  value:
    | void
    | PrimaryReviewDispositionReport
    | { dispositions?: PrimaryReviewDispositionReport; finishedEarly?: boolean }
    | undefined,
): ReviewRepairOutcome {
  if (value === undefined) return { finishedEarly: false };
  if ("findingDispositions" in value) return { dispositions: value, finishedEarly: false };
  return {
    ...(value.dispositions === undefined ? {} : { dispositions: value.dispositions }),
    finishedEarly: value.finishedEarly === true,
  };
}

export function parsePrimaryReviewRepairOutcome(
  output: string,
  expectedFindingIds: readonly string[],
  expectedRequirementIds: readonly string[],
): ReviewRepairOutcome {
  try {
    const text = extractOpenCodeTextOutput(output);
    const lines = text.split(/\r?\n/u);
    const markerLines = lines.flatMap((line, index) =>
      line === REVIEW_REPAIR_FINISHED_EARLY_MARKER ? [index] : [],
    );
    let finishedEarly = false;
    let reportText = text;
    if (markerLines.length > 0) {
      const markerIndex = markerLines[0]!;
      if (
        markerLines.length !== 1 ||
        lines.slice(markerIndex + 1).some((line) => line.trim().length > 0)
      )
        return { finishedEarly: false };
      finishedEarly = true;
      reportText = lines.slice(0, markerIndex).join("\n").trim();
    }
    const dispositions = parsePrimaryReviewDispositionReport(
      reportText,
      expectedFindingIds,
      expectedRequirementIds,
    );
    return {
      ...(dispositions === undefined ? {} : { dispositions }),
      finishedEarly,
    };
  } catch {
    return { finishedEarly: false };
  }
}

export interface TaskSessionReviewRepairResult extends TaskSessionReviewRound {
  attempts: number;
  record: TaskExecutionRecord;
}

export class TaskSessionReviewRepairError extends Error {
  constructor(
    message: string,
    options?: ErrorOptions,
    public readonly sourceIdentity?: {
      before: string;
      after: string | null;
      unchanged: boolean;
    },
  ) {
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

const MAX_DIAGNOSTIC_FINDING_IDS = 50;

function boundedIds(ids: readonly string[]): {
  ids: string[];
  omitted: number;
} {
  return {
    ids: ids.slice(0, MAX_DIAGNOSTIC_FINDING_IDS),
    omitted: Math.max(0, ids.length - MAX_DIAGNOSTIC_FINDING_IDS),
  };
}

function logReviewDiagnostic(
  options: RunTaskSessionReviewRepairsOptions,
  event: string,
  fields: Record<string, unknown>,
): void {
  logger
    .child({ projectId: options.projectId, cardId: options.cardId })
    .event(`review-cycle ${JSON.stringify({ event, ...fields })}`);
}

function qualityDiagnostic(record: TaskExecutionRecord): {
  validation: "passed" | "not-passed";
  coverage: "passed" | "unavailable";
  validationContentIdentity?: string;
  coverageContentIdentity?: string;
} {
  const validation = record.validationRepair;
  const coverageConfigured = validation?.coverageEvidence !== undefined;
  return {
    validation: validation?.status === "passed" ? "passed" : "not-passed",
    coverage: coverageConfigured ? "passed" : "unavailable",
    ...(validation?.evidence === undefined
      ? {}
      : { validationContentIdentity: validation.evidence.contentIdentity }),
    ...(validation?.coverageEvidence === undefined
      ? {}
      : {
          coverageContentIdentity: validation.coverageEvidence.contentIdentity,
        }),
  };
}

function logReviewStageFailure(
  options: RunTaskSessionReviewRepairsOptions,
  record: TaskExecutionRecord,
  stage: "execution" | "source-identity-check" | "result-validation",
  contentIdentity?: string,
): void {
  logReviewDiagnostic(options, "cycle-failed", {
    category: "review",
    stage,
    reviewPass: record.retryCounters.review + 1,
    remediationAttempt: record.retryCounters.review,
    ...(contentIdentity === undefined ? {} : { contentIdentity }),
    ...qualityDiagnostic(record),
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
    (record.phase !== "review" &&
      record.phase !== "validation" &&
      record.phase !== "implementation" &&
      record.phase !== "publication")
  ) {
    throw new TaskSessionReviewRepairError(
      "Review repair requires the owned task and exact primary session",
    );
  }
}

function updateFindingLedger(
  review: ImplementationReviewResult,
  contentIdentity: string,
  previous: readonly TrackedFinding[],
  cycleId: string,
): { review: ImplementationReviewResult; findings: TrackedFinding[] } {
  const assessments = review.previousFindingAssessments ?? [];
  const byId = new Map(assessments.map((assessment) => [assessment.findingId, assessment]));
  for (const finding of previous) {
    if (!byId.has(finding.id)) {
      throw new TaskSessionReviewRepairError(`Review omitted prior finding ${finding.id}`);
    }
  }

  for (const finding of previous) {
    const assessment = byId.get(finding.id)!;
    const blockingFinding = review.blockingFindings.find(
      (candidate) => candidate.id === finding.id,
    );
    const isReportedBlocking = blockingFinding !== undefined;
    const evidenceBackedReopening =
      assessment.status === "resolved" &&
      blockingFinding !== undefined &&
      blockingFinding.sourceContentIdentity === contentIdentity &&
      !finding.sourceIdentities.includes(contentIdentity) &&
      blockingFinding.location !== undefined;
    if (assessment.status === "unresolved" && !isReportedBlocking) {
      throw new TaskSessionReviewRepairError(
        `Unresolved prior finding must remain blocking: ${finding.id}`,
      );
    }
    if (assessment.status !== "unresolved" && isReportedBlocking && !evidenceBackedReopening) {
      throw new TaskSessionReviewRepairError(
        `Review lists ${assessment.status} prior finding as blocking: ${finding.id}`,
      );
    }
  }
  if (review.verdict === "pass" && assessments.some(({ status }) => status === "unresolved")) {
    throw new TaskSessionReviewRepairError(
      "A passing review cannot leave prior blocking findings unresolved",
    );
  }

  const updated = previous.map((finding) => {
    const assessment = byId.get(finding.id)!;
    return {
      ...finding,
      sourceIdentities: finding.sourceIdentities.includes(contentIdentity)
        ? finding.sourceIdentities
        : [...finding.sourceIdentities, contentIdentity],
      status: assessment.status,
      ...(assessment.justification === undefined
        ? { justification: undefined }
        : { justification: assessment.justification }),
    };
  });
  const normalizedFindings: ImplementationReviewResult["blockingFindings"] = [];
  for (const finding of review.blockingFindings) {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([cycleId, finding.kind, finding.summary, finding.location ?? null]))
      .digest("hex");
    const id = finding.id ?? `finding-${fingerprint.slice(0, 32)}`;
    const old = updated.find((candidate) => candidate.id === id);
    if (finding.id !== undefined && old === undefined) {
      throw new TaskSessionReviewRepairError(
        `Review blocking finding references unknown prior finding: ${finding.id}`,
      );
    }
    const priorAssessment = finding.id === undefined ? undefined : byId.get(finding.id);
    const priorFinding =
      finding.id === undefined
        ? undefined
        : previous.find((candidate) => candidate.id === finding.id);
    const evidenceBackedReopening =
      priorAssessment?.status === "resolved" &&
      priorFinding !== undefined &&
      finding.sourceContentIdentity === contentIdentity &&
      !priorFinding.sourceIdentities.includes(contentIdentity) &&
      finding.location !== undefined;
    if (
      finding.id !== undefined &&
      priorAssessment?.status !== "unresolved" &&
      !evidenceBackedReopening
    ) {
      throw new TaskSessionReviewRepairError(
        `Review lists a non-unresolved prior finding as blocking: ${finding.id}`,
      );
    }
    if (old !== undefined) {
      old.status = "unresolved";
      old.justification = undefined;
      old.sourceIdentities = old.sourceIdentities.includes(contentIdentity)
        ? old.sourceIdentities
        : [...old.sourceIdentities, contentIdentity];
    } else {
      updated.push({
        ...finding,
        id,
        sourceContentIdentity: contentIdentity,
        sourceIdentities: [contentIdentity],
        status: "unresolved",
        justification: undefined,
      });
    }
    normalizedFindings.push({
      ...finding,
      id,
      sourceContentIdentity: contentIdentity,
    });
  }

  return {
    review: { ...review, blockingFindings: normalizedFindings },
    findings: updated,
  };
}

async function completePrimaryRepair(
  options: RunTaskSessionReviewRepairsOptions,
  review: ImplementationReviewResult,
  operationId: string,
  outcome: ReviewRepairOutcome,
  afterIdentity: string,
): Promise<{
  record: TaskExecutionRecord;
  noChange: boolean;
  contentIdentity: string;
}> {
  logReviewDiagnostic(options, "repair-content-checked", {
    operationId,
    beforeContentIdentity: review.reviewedContentIdentity,
    afterContentIdentity: afterIdentity,
    changedImmediately: afterIdentity !== review.reviewedContentIdentity,
  });
  await options.rerunQuality();
  const finalIdentity = await options.getCurrentContentIdentity();
  const noChange = finalIdentity === review.reviewedContentIdentity;
  const finishAfterNextReview =
    afterIdentity === review.reviewedContentIdentity
      ? ("no-change" as const)
      : outcome.finishedEarly
        ? ("finished-early" as const)
        : undefined;
  let latest = options.store.read(options.cardId);
  assertOwner(latest, options);
  const findingIds = new Set(
    review.blockingFindings.flatMap(({ id }) => (id === undefined ? [] : [id])),
  );
  const transitionEvent = {
    type: "validation-reviewed" as const,
    eventId: `${options.operationKey}:validation-reviewed`,
    projectId: options.projectId,
    cardId: options.cardId,
    operationKey: options.operationKey,
    occurredAt: nextTimestamp(latest.updatedAt),
  };
  const baseRevision = latest.revision;
  const baseTimestamp = latest.updatedAt;
  const needsReviewTransition = noChange && latest.phase === "validation";
  if (needsReviewTransition) latest = transitionTaskExecutionRecord(latest, transitionEvent);
  const reviewRepair = latest.reviewRepair;
  if (reviewRepair?.activePrimaryOperation?.operationId !== operationId)
    return { record: latest, noChange: false, contentIdentity: finalIdentity };
  const update = {
    reviewRepair: {
      ...reviewRepair,
      ...(noChange
        ? {
            status: "exhausted" as const,
            stopReason: "no-change" as const,
            finishAfterNextReview: undefined,
          }
        : {
            status: "active" as const,
            stopReason: undefined,
            finishAfterNextReview,
          }),
      activePrimaryOperation: undefined,
      finalReview: review,
      findings: reviewRepair.findings?.map((finding) => {
        if (!findingIds.has(finding.id)) return finding;
        const disposition = outcome.dispositions?.findingDispositions.find(
          (item) => item.findingId === finding.id,
        );
        return disposition === undefined
          ? { ...finding, primaryDisposition: undefined }
          : {
              ...finding,
              primaryDisposition: {
                reviewedContentIdentity: review.reviewedContentIdentity,
                status: disposition.status,
                rationale: disposition.rationale,
              },
            };
      }),
      requirementDispositions: (reviewRepair.requirementDispositions ?? [])
        .filter(
          (item) =>
            !review.requirementAssessments.some(
              (assessment) =>
                assessment.status === "unsatisfied" &&
                assessment.requirementId === item.requirementId,
            ),
        )
        .concat(
          outcome.dispositions?.requirementDispositions.map((disposition) => ({
            ...disposition,
            reviewedContentIdentity: review.reviewedContentIdentity,
          })) ?? [],
        ),
    },
  } satisfies Partial<TaskExecutionRecord>;
  const updated = needsReviewTransition
    ? options.store.compareAndSwap(options.cardId, baseRevision, {
        ...latest,
        ...update,
        revision: baseRevision + 1,
        updatedAt: nextTimestamp(baseTimestamp),
      })
    : updateRecord(options.store, latest, update);
  return { record: updated, noChange, contentIdentity: finalIdentity };
}

export async function runTaskSessionReviewWithRepairs(
  options: RunTaskSessionReviewRepairsOptions,
): Promise<TaskSessionReviewRepairResult> {
  if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 0)
    throw new TaskSessionReviewRepairError("Invalid configured review repair limit");
  let record = options.store.read(options.cardId);
  assertOwner(record, options);
  const cycleId =
    record.reviewRepair?.activePrimaryOperation !== undefined
      ? record.reviewRepair.cycleId
      : (options.reviewCycleId ?? options.operationKey);

  if (record.reviewRepair?.cycleId !== cycleId) {
    record = updateRecord(options.store, record, {
      retryCounters: { ...record.retryCounters, review: 0 },
      reviewRepair: {
        cycleId,
        status: "active",
        maxAttempts: options.maxAttempts,
      },
    });
  } else if (record.reviewRepair.maxAttempts === undefined) {
    const legacyMaximum = Math.max(
      options.maxAttempts,
      record.retryCounters.review,
      record.reviewRepair.activePrimaryOperation?.pass ?? 0,
    );
    record = updateRecord(options.store, record, {
      reviewRepair: {
        ...record.reviewRepair,
        maxAttempts: legacyMaximum,
      },
    });
  }
  logReviewDiagnostic(options, "cycle-started", {
    reviewPass: record.retryCounters.review + 1,
    remediationAttempt: record.retryCounters.review,
    status: record.reviewRepair?.status ?? "active",
    ...qualityDiagnostic(record),
  });

  // A completed review round is durable. Recovery must not consume another
  // repair or run another review when its source snapshot is unchanged.
  if (record.reviewRepair?.status === "exhausted" || record.reviewRepair?.status === "passed") {
    if (
      record.reviewRepair.status === "passed" &&
      record.reviewRepair.findings?.some((finding) => finding.status === "unresolved")
    ) {
      throw new TaskSessionReviewRepairError(
        "Persisted passing review contains unresolved blocking findings",
      );
    }
    const previous = record.reviewRepair.finalReview;
    if (previous !== undefined) {
      const contentIdentity = await options.getCurrentContentIdentity();
      if (previous.reviewedContentIdentity !== contentIdentity)
        throw new TaskSessionReviewRepairError(
          "Persisted final review belongs to a stale source snapshot",
        );
      logReviewDiagnostic(options, "cycle-recovered", {
        reviewPass: record.retryCounters.review + 1,
        remediationAttempt: record.retryCounters.review,
        verdict: previous.verdict,
        contentIdentity: previous.reviewedContentIdentity,
        blockingFindingIds: boundedIds(previous.blockingFindings.map(({ id }) => id ?? "unknown")),
        ...qualityDiagnostic(record),
      });
      return {
        review: previous,
        contentIdentity,
        attempts: record.retryCounters.review,
        record,
      };
    }
    // Pre-upgrade exhausted records have no final review evidence. Perform
    // one read-only recovery review, persist it, and never repeat it on restart.
    let round: TaskSessionReviewRound;
    try {
      round = await options.runReview(record.reviewRepair?.findings ?? []);
    } catch (error) {
      logReviewStageFailure(options, record, "execution");
      throw error;
    }
    let currentIdentity: string;
    try {
      currentIdentity = await options.getCurrentContentIdentity();
    } catch (error) {
      logReviewStageFailure(options, record, "source-identity-check", round.contentIdentity);
      throw error;
    }
    if (
      round.contentIdentity !== currentIdentity ||
      round.review.reviewedContentIdentity !== currentIdentity
    ) {
      logReviewStageFailure(options, record, "source-identity-check", round.contentIdentity);
      throw new TaskSessionReviewRepairError("Recovered review belongs to a stale source snapshot");
    }
    record = updateRecord(options.store, record, {
      reviewRepair: {
        cycleId,
        status: round.review.verdict === "pass" ? "passed" : "exhausted",
        requirementDispositions: record.reviewRepair?.requirementDispositions,
        finalReview: round.review,
        // The old hardcoded limit was two; do not retroactively change it.
        maxAttempts:
          round.review.verdict === "fail"
            ? record.retryCounters.review
            : Math.max(record.retryCounters.review, options.maxAttempts),
      },
    });
    logReviewDiagnostic(options, "cycle-recovered", {
      reviewPass: record.retryCounters.review + 1,
      remediationAttempt: record.retryCounters.review,
      verdict: round.review.verdict,
      contentIdentity: round.review.reviewedContentIdentity,
      blockingFindingIds: boundedIds(
        round.review.blockingFindings.map(({ id }) => id ?? "unknown"),
      ),
      ...qualityDiagnostic(record),
    });
    return {
      ...round,
      attempts: record.retryCounters.review,
      record,
    };
  }

  for (;;) {
    const active = record.reviewRepair?.activePrimaryOperation;
    if (active !== undefined) {
      if (active.promptArtifact === undefined)
        throw new TaskSessionReviewRepairError(
          "Reserved review repair lacks its persisted prompt; preserving the reservation",
        );
      const stored: unknown = options.store.readPrimaryResultArtifact({
        reference: active.promptArtifact.reference as `sha256:${string}`,
        bytes: active.promptArtifact.bytes,
        ...(active.promptArtifact.path === undefined ? {} : { path: active.promptArtifact.path }),
      });
      if (
        typeof stored !== "object" ||
        stored === null ||
        !("prompt" in stored) ||
        typeof stored.prompt !== "string" ||
        !("review" in stored) ||
        typeof stored.review !== "object" ||
        stored.review === null
      )
        throw new TaskSessionReviewRepairError(
          "Persisted review repair evidence is invalid; preserving the reservation",
        );
      const retainedReview = stored.review as ImplementationReviewResult;
      updateRecord(options.store, record, {
        reviewRepair: {
          ...record.reviewRepair!,
          finalReview: retainedReview,
        },
      });
      let outcome: ReviewRepairOutcome;
      let afterRepairIdentity: string;
      try {
        outcome = normalizeRepairOutcome(
          await options.repair(retainedReview, active.pass, active.operationId, stored.prompt),
        );
        afterRepairIdentity = await options.getCurrentContentIdentity();
      } catch (error) {
        throw new TaskSessionReviewRepairError(
          `Reserved review repair pass ${active.pass} did not complete; reservation is preserved`,
          { cause: error },
        );
      }
      const completed = await completePrimaryRepair(
        options,
        retainedReview,
        active.operationId,
        outcome,
        afterRepairIdentity,
      );
      record = completed.record;
      if (completed.noChange) {
        logReviewDiagnostic(options, "cycle-stopped", {
          stopReason: "no-change",
          remediationAttempt: active.pass,
          contentIdentity: completed.contentIdentity,
          blockingFindingIds: boundedIds(
            retainedReview.blockingFindings.map(({ id }) => id ?? "unknown"),
          ),
        });
        return {
          review: retainedReview,
          contentIdentity: completed.contentIdentity,
          attempts: record.retryCounters.review,
          record,
        };
      }
      continue;
    }
    let round: TaskSessionReviewRound;
    try {
      round = await options.runReview(record.reviewRepair?.findings ?? []);
    } catch (error) {
      logReviewStageFailure(options, record, "execution");
      throw error;
    }
    let currentIdentity: string;
    try {
      currentIdentity = await options.getCurrentContentIdentity();
    } catch (error) {
      logReviewStageFailure(options, record, "source-identity-check", round.contentIdentity);
      throw error;
    }
    if (
      round.contentIdentity !== currentIdentity ||
      round.review.reviewedContentIdentity !== currentIdentity
    ) {
      logReviewStageFailure(options, record, "source-identity-check", round.contentIdentity);
      throw new TaskSessionReviewRepairError(
        "Review result or quality evidence belongs to a stale source snapshot",
      );
    }

    let ledger: ReturnType<typeof updateFindingLedger>;
    try {
      ledger = updateFindingLedger(
        round.review,
        round.contentIdentity,
        record.reviewRepair?.findings ?? [],
        cycleId,
      );
    } catch (error) {
      logReviewStageFailure(options, record, "result-validation", round.contentIdentity);
      throw error;
    }
    const trackedRound = { ...round, review: ledger.review };
    record = options.store.read(options.cardId);
    assertOwner(record, options);

    const assessments = ledger.review.previousFindingAssessments ?? [];
    const previousIds = new Set((record.reviewRepair?.findings ?? []).map(({ id }) => id));
    const resolvedIds = assessments
      .filter(({ status }) => status === "resolved" || status === "superseded")
      .map(({ findingId }) => findingId);
    const unresolvedIds = assessments
      .filter(({ status }) => status === "unresolved")
      .map(({ findingId }) => findingId);
    const newIds = ledger.review.blockingFindings
      .filter(({ id }) => id !== undefined && !previousIds.has(id))
      .map(({ id }) => id!);
    logReviewDiagnostic(options, "review-round", {
      reviewPass: record.retryCounters.review + 1,
      remediationAttempt: record.retryCounters.review,
      verdict: ledger.review.verdict,
      contentIdentity: round.contentIdentity,
      blockingFindingIds: boundedIds(
        ledger.review.blockingFindings.map(({ id }) => id ?? "unknown"),
      ),
      findingsBeforeRemediation: boundedIds([...previousIds]),
      resolvedFindingIds: boundedIds(resolvedIds),
      unresolvedFindingIds: boundedIds(unresolvedIds),
      newlyDiscoveredBlockingFindingIds: boundedIds(newIds),
      ...qualityDiagnostic(record),
    });

    const attempts = record.retryCounters.review;
    const pendingFinish = record.reviewRepair?.finishAfterNextReview;
    const finishAfterNextReview =
      pendingFinish === true ? "finished-early" : pendingFinish || undefined;
    if (round.review.verdict === "pass") {
      record = updateRecord(options.store, record, {
        reviewRepair: {
          cycleId,
          status: "passed",
          maxAttempts: record.reviewRepair?.maxAttempts ?? options.maxAttempts,
          requirementDispositions: record.reviewRepair?.requirementDispositions,
          finalReview: ledger.review,
          findings: ledger.findings,
        },
      });
      logReviewDiagnostic(options, "cycle-passed", {
        reviewPass: attempts + 1,
        remediationAttempt: attempts,
        contentIdentity: round.contentIdentity,
        blockingFindingIds: [],
        ...qualityDiagnostic(record),
      });
      return { ...trackedRound, attempts: record.retryCounters.review, record };
    }

    if (finishAfterNextReview) {
      record = updateRecord(options.store, record, {
        reviewRepair: {
          cycleId,
          status: "exhausted",
          stopReason: finishAfterNextReview,
          maxAttempts: record.reviewRepair?.maxAttempts ?? options.maxAttempts,
          requirementDispositions: record.reviewRepair?.requirementDispositions,
          finalReview: ledger.review,
          findings: ledger.findings,
        },
      });
      logReviewDiagnostic(options, "cycle-stopped", {
        stopReason: finishAfterNextReview,
        reviewPass: attempts + 1,
        remediationAttempt: attempts,
        contentIdentity: round.contentIdentity,
        blockingFindingIds: boundedIds(
          ledger.review.blockingFindings.map(({ id }) => id ?? "unknown"),
        ),
        ...qualityDiagnostic(record),
      });
      return { ...trackedRound, attempts, record };
    }

    if (attempts >= (record.reviewRepair?.maxAttempts ?? options.maxAttempts)) {
      record = updateRecord(options.store, record, {
        reviewRepair: {
          cycleId,
          status: "exhausted",
          stopReason: "attempt-limit",
          maxAttempts: record.reviewRepair?.maxAttempts ?? options.maxAttempts,
          requirementDispositions: record.reviewRepair?.requirementDispositions,
          finalReview: ledger.review,
          findings: ledger.findings,
        },
      });
      logReviewDiagnostic(options, "cycle-exhausted", {
        reviewPass: attempts + 1,
        remediationAttempt: attempts,
        blockingFindingIds: boundedIds(
          ledger.review.blockingFindings.map(({ id }) => id ?? "unknown"),
        ),
        unresolvedFindingIds: boundedIds(
          ledger.findings.filter(({ status }) => status === "unresolved").map(({ id }) => id),
        ),
        contentIdentity: round.contentIdentity,
        ...qualityDiagnostic(record),
      });
      return { ...trackedRound, attempts, record };
    }

    const repairAttempt = attempts + 1;
    const operationId = `${options.operationKey}:review:${cycleId}:pass:${repairAttempt}`;
    const prompt =
      (await options.buildRepairPrompt?.(ledger.review, repairAttempt)) ??
      JSON.stringify({ review: ledger.review, attempt: repairAttempt });
    const promptArtifact = options.store.writePrimaryResultArtifact(`${operationId}:prompt`, {
      prompt,
      review: ledger.review,
    });
    updateRecord(options.store, record, {
      retryCounters: { ...record.retryCounters, review: repairAttempt },
      // Once a primary repair is durably reserved, older remediation-failure
      // state must not be allowed to classify or publish around it.
      reviewRemediationFailure: undefined,
      reviewRepair: {
        cycleId,
        status: "active",
        maxAttempts: record.reviewRepair?.maxAttempts ?? options.maxAttempts,
        finalReview: ledger.review,
        requirementDispositions: record.reviewRepair?.requirementDispositions,
        findings: ledger.findings,
        activePrimaryOperation: {
          operationId,
          pass: repairAttempt,
          promptArtifact,
        },
      },
    });
    logReviewDiagnostic(options, "remediation-started", {
      reviewPass: attempts + 1,
      remediationAttempt: repairAttempt,
      findingsBeforeRemediation: boundedIds(
        ledger.findings.filter(({ status }) => status === "unresolved").map(({ id }) => id),
      ),
      contentIdentity: round.contentIdentity,
    });
    let failureCategory: "remediation-execution" | "source-identity-check" | "validation" =
      "remediation-execution";
    let outcome: ReviewRepairOutcome;
    let afterRepairIdentity: string;
    try {
      outcome = normalizeRepairOutcome(
        await options.repair(ledger.review, repairAttempt, operationId, prompt),
      );
      failureCategory = "source-identity-check";
      afterRepairIdentity = await options.getCurrentContentIdentity();
      failureCategory = "validation";
      const completed = await completePrimaryRepair(
        options,
        ledger.review,
        operationId,
        outcome,
        afterRepairIdentity,
      );
      record = completed.record;
      logReviewDiagnostic(options, "remediation-completed", {
        reviewPass: attempts + 1,
        remediationAttempt: attempts + 1,
        beforeContentIdentity: round.contentIdentity,
        afterContentIdentity: afterRepairIdentity,
        noChange: completed.noChange,
        ...qualityDiagnostic(options.store.read(options.cardId) ?? record),
      });
      if (completed.noChange) {
        logReviewDiagnostic(options, "cycle-stopped", {
          stopReason: "no-change",
          remediationAttempt: repairAttempt,
          contentIdentity: afterRepairIdentity,
          blockingFindingIds: boundedIds(
            ledger.review.blockingFindings.map(({ id }) => id ?? "unknown"),
          ),
        });
        return {
          review: ledger.review,
          contentIdentity: afterRepairIdentity,
          attempts: record.retryCounters.review,
          record,
        };
      }
    } catch (error) {
      const primaryRecoveryError = findPrimaryRecoveryError(error);
      if (primaryRecoveryError !== undefined)
        throw new TaskSessionReviewRepairError(
          "Primary review repair requires durable recovery; preserving its reservation and execution outcome",
          { cause: primaryRecoveryError },
        );
      // Failed remediation can leave partial source changes. Inspect rather
      // than interpreting an incomplete repair as an exhausted review verdict.
      let after: string | null = null;
      try {
        after = await options.getCurrentContentIdentity();
      } catch {
        // A failed identity check must never make recovery appear safe.
      }
      const before = currentIdentity;
      const unchanged = after !== null && before === after;
      const latest = options.store.read(options.cardId);
      if (
        latest === null ||
        latest.projectId !== options.projectId ||
        latest.operationKey !== options.operationKey ||
        latest.primarySessionId !== options.expectedPrimarySessionId
      )
        throw new TaskSessionReviewRepairError(
          "Review remediation failed and task ownership changed",
          { cause: error },
          { before, after, unchanged: false },
        );
      if (latest.reviewRepair?.activePrimaryOperation?.operationId !== operationId) {
        updateRecord(options.store, latest, {
          reviewRemediationFailure: {
            cycleId,
            attempt: repairAttempt,
            before,
            after,
            unchanged,
            diagnostic: "Review remediation did not complete",
          },
        });
      }
      logReviewDiagnostic(options, "cycle-failed", {
        category: failureCategory,
        reviewPass: attempts + 1,
        remediationAttempt: repairAttempt,
        blockingFindingIds: boundedIds(
          ledger.review.blockingFindings.map(({ id }) => id ?? "unknown"),
        ),
        findingsBeforeRemediation: boundedIds(
          ledger.findings.filter(({ status }) => status === "unresolved").map(({ id }) => id),
        ),
        beforeContentIdentity: before,
        afterContentIdentity: after,
        unchanged,
      });
      throw new TaskSessionReviewRepairError(
        `${failureCategory === "validation" ? "Review remediation completed but validation or coverage failed" : "Review repair execution failed"} on attempt ${attempts + 1}; ${unchanged ? "source identity unchanged" : "source may have changed or could not be verified"}; task state is preserved`,
        { cause: error },
        { before, after, unchanged },
      );
    }
  }
}
