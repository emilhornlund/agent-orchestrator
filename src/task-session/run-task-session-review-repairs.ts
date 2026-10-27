import { createHash } from "node:crypto";
import type { ImplementationReviewResult } from "./implementation-review-result.js";
import type { TaskExecutionRecord } from "./task-execution-record.js";
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
    const isReportedBlocking = review.blockingFindings.some(
      (blockingFinding) => blockingFinding.id === finding.id,
    );
    if (assessment.status === "unresolved" && !isReportedBlocking) {
      throw new TaskSessionReviewRepairError(
        `Unresolved prior finding must remain blocking: ${finding.id}`,
      );
    }
    if (assessment.status !== "unresolved" && isReportedBlocking) {
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
    if (
      finding.id !== undefined &&
      byId.get(finding.id)?.status !== "unresolved"
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
      return {
        review: previous,
        contentIdentity,
        attempts: record.retryCounters.review,
        record,
      };
    }
    // Pre-upgrade exhausted records have no final review evidence. Perform
    // one read-only recovery review, persist it, and never repeat it on restart.
    const round = await options.runReview(record.reviewRepair?.findings ?? []);
    const currentIdentity = await options.getCurrentContentIdentity();
    if (
      round.contentIdentity !== currentIdentity ||
      round.review.reviewedContentIdentity !== currentIdentity
    )
      throw new TaskSessionReviewRepairError(
        "Recovered review belongs to a stale source snapshot",
      );
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
    return {
      ...round,
      attempts: record.retryCounters.review,
      record,
    };
  }

  for (;;) {
    const round = await options.runReview(record.reviewRepair?.findings ?? []);
    const currentIdentity = await options.getCurrentContentIdentity();
    if (
      round.contentIdentity !== currentIdentity ||
      round.review.reviewedContentIdentity !== currentIdentity
    ) {
      throw new TaskSessionReviewRepairError(
        "Review result or quality evidence belongs to a stale source snapshot",
      );
    }

    const ledger = updateFindingLedger(
      round.review,
      round.contentIdentity,
      record.reviewRepair?.findings ?? [],
      cycleId,
    );
    const trackedRound = { ...round, review: ledger.review };
    record = options.store.read(options.cardId);
    assertOwner(record, options);

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
      return { ...trackedRound, attempts: record.retryCounters.review, record };
    }

    const attempts = record.retryCounters.review;
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
    try {
      await options.repair(ledger.review, attempts + 1);
      await options.rerunQuality();
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
      throw new TaskSessionReviewRepairError(
        `Review repair attempt ${attempts + 1} did not complete; ${unchanged ? "source identity unchanged" : "source may have changed or could not be verified"}; task state is preserved`,
        { cause: error },
        { before, after, unchanged },
      );
    }
  }
}
