import { createHash } from "node:crypto";
import type { ImplementationReviewResult } from "./implementation-review-result.js";
import type { TaskExecutionRecord } from "./task-execution-record.js";
import { logger } from "../logging/logger.js";
import { TaskExecutionStore } from "./task-execution-store.js";

type TrackedFinding = NonNullable<
  NonNullable<TaskExecutionRecord["reviewRepair"]>["findings"]
>[number];

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
  runReview: (
    previousFindings: readonly TrackedFinding[],
  ) => Promise<TaskSessionReviewRound>;
  repair: (
    review: ImplementationReviewResult,
    attempt: number,
  ) => Promise<void>;
  rerunQuality: () => Promise<void>;
  getCurrentContentIdentity: () => Promise<string>;
  maxAttempts: number;
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
    (record.phase !== "review" && record.phase !== "validation")
  ) {
    throw new TaskSessionReviewRepairError(
      "Review repair requires the owned review-phase task and exact primary session",
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
  const byId = new Map(
    assessments.map((assessment) => [assessment.findingId, assessment]),
  );
  for (const finding of previous) {
    if (!byId.has(finding.id)) {
      throw new TaskSessionReviewRepairError(
        `Review omitted prior finding ${finding.id}`,
      );
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
    if (
      assessment.status !== "unresolved" &&
      isReportedBlocking &&
      !evidenceBackedReopening
    ) {
      throw new TaskSessionReviewRepairError(
        `Review lists ${assessment.status} prior finding as blocking: ${finding.id}`,
      );
    }
  }
  if (
    review.verdict === "pass" &&
    assessments.some(({ status }) => status === "unresolved")
  ) {
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
      .update(
        JSON.stringify([
          cycleId,
          finding.kind,
          finding.summary,
          finding.location ?? null,
        ]),
      )
      .digest("hex");
    const id = finding.id ?? `finding-${fingerprint.slice(0, 32)}`;
    const old = updated.find((candidate) => candidate.id === id);
    if (finding.id !== undefined && old === undefined) {
      throw new TaskSessionReviewRepairError(
        `Review blocking finding references unknown prior finding: ${finding.id}`,
      );
    }
    const priorAssessment =
      finding.id === undefined ? undefined : byId.get(finding.id);
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

export async function runTaskSessionReviewWithRepairs(
  options: RunTaskSessionReviewRepairsOptions,
): Promise<TaskSessionReviewRepairResult> {
  if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 0)
    throw new TaskSessionReviewRepairError(
      "Invalid configured review repair limit",
    );
  let record = options.store.read(options.cardId);
  assertOwner(record, options);
  const cycleId = options.operationKey;

  if (record.reviewRepair?.cycleId !== cycleId) {
    record = updateRecord(options.store, record, {
      retryCounters: { ...record.retryCounters, review: 0 },
      reviewRepair: {
        cycleId,
        status: "active",
        maxAttempts: options.maxAttempts,
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
  if (
    record.reviewRepair?.status === "exhausted" ||
    record.reviewRepair?.status === "passed"
  ) {
    if (
      record.reviewRepair.status === "passed" &&
      record.reviewRepair.findings?.some(
        (finding) => finding.status === "unresolved",
      )
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
        blockingFindingIds: boundedIds(
          previous.blockingFindings.map(({ id }) => id ?? "unknown"),
        ),
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
      logReviewStageFailure(
        options,
        record,
        "source-identity-check",
        round.contentIdentity,
      );
      throw error;
    }
    if (
      round.contentIdentity !== currentIdentity ||
      round.review.reviewedContentIdentity !== currentIdentity
    ) {
      logReviewStageFailure(
        options,
        record,
        "source-identity-check",
        round.contentIdentity,
      );
      throw new TaskSessionReviewRepairError(
        "Recovered review belongs to a stale source snapshot",
      );
    }
    record = updateRecord(options.store, record, {
      reviewRepair: {
        cycleId,
        status: round.review.verdict === "pass" ? "passed" : "exhausted",
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
      logReviewStageFailure(
        options,
        record,
        "source-identity-check",
        round.contentIdentity,
      );
      throw error;
    }
    if (
      round.contentIdentity !== currentIdentity ||
      round.review.reviewedContentIdentity !== currentIdentity
    ) {
      logReviewStageFailure(
        options,
        record,
        "source-identity-check",
        round.contentIdentity,
      );
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
      logReviewStageFailure(
        options,
        record,
        "result-validation",
        round.contentIdentity,
      );
      throw error;
    }
    const trackedRound = { ...round, review: ledger.review };
    record = options.store.read(options.cardId);
    assertOwner(record, options);

    const assessments = ledger.review.previousFindingAssessments ?? [];
    const previousIds = new Set(
      (record.reviewRepair?.findings ?? []).map(({ id }) => id),
    );
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
    if (round.review.verdict === "pass") {
      record = updateRecord(options.store, record, {
        reviewRepair: {
          cycleId,
          status: "passed",
          maxAttempts: record.reviewRepair?.maxAttempts ?? options.maxAttempts,
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

    if (attempts >= (record.reviewRepair?.maxAttempts ?? options.maxAttempts)) {
      record = updateRecord(options.store, record, {
        reviewRepair: {
          cycleId,
          status: "exhausted",
          maxAttempts: record.reviewRepair?.maxAttempts ?? options.maxAttempts,
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
          ledger.findings
            .filter(({ status }) => status === "unresolved")
            .map(({ id }) => id),
        ),
        contentIdentity: round.contentIdentity,
        ...qualityDiagnostic(record),
      });
      return { ...trackedRound, attempts, record };
    }

    record = updateRecord(options.store, record, {
      retryCounters: { ...record.retryCounters, review: attempts + 1 },
      reviewRepair: {
        cycleId,
        status: "active",
        maxAttempts: record.reviewRepair?.maxAttempts ?? options.maxAttempts,
        findings: ledger.findings,
      },
    });
    logReviewDiagnostic(options, "remediation-started", {
      reviewPass: attempts + 1,
      remediationAttempt: attempts + 1,
      findingsBeforeRemediation: boundedIds(
        ledger.findings
          .filter(({ status }) => status === "unresolved")
          .map(({ id }) => id),
      ),
      contentIdentity: round.contentIdentity,
    });
    let failureCategory: "remediation-execution" | "validation" =
      "remediation-execution";
    try {
      await options.repair(ledger.review, attempts + 1);
      failureCategory = "validation";
      await options.rerunQuality();
      logReviewDiagnostic(options, "remediation-completed", {
        reviewPass: attempts + 1,
        remediationAttempt: attempts + 1,
        beforeContentIdentity: round.contentIdentity,
        ...qualityDiagnostic(options.store.read(options.cardId) ?? record),
      });
    } catch (error) {
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
      updateRecord(options.store, latest, {
        reviewRemediationFailure: {
          cycleId,
          attempt: attempts + 1,
          before,
          after,
          unchanged,
          diagnostic: "Review remediation did not complete",
        },
      });
      logReviewDiagnostic(options, "cycle-failed", {
        category: failureCategory,
        reviewPass: attempts + 1,
        remediationAttempt: attempts + 1,
        blockingFindingIds: boundedIds(
          ledger.review.blockingFindings.map(({ id }) => id ?? "unknown"),
        ),
        findingsBeforeRemediation: boundedIds(
          ledger.findings
            .filter(({ status }) => status === "unresolved")
            .map(({ id }) => id),
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
