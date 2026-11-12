import type { ProjectConfig } from "../config/config.js";
import type { CiCheckEvaluation } from "../github/evaluate-ci-checks.js";
import { FeedbackLedgerStore } from "./feedback-ledger-store.js";
import type { FeedbackLedgerEntry } from "./feedback-ledger.js";
import type { FeedbackVerificationResult, FeedbackDisposition } from "./feedback-verification.js";

export type FeedbackReplyReconciliation =
  | { status: "found"; replyId: string }
  | { status: "absent" }
  | { status: "unknown"; reason: string };

export interface PublishVerifiedFeedbackRepliesOptions {
  project: ProjectConfig;
  cardId: string;
  pullRequestUrl: string;
  publishedCommitSha: string;
  observedHeadSha: string;
  ciEvaluation: CiCheckEvaluation;
  verification: FeedbackVerificationResult;
  ledgerStore: FeedbackLedgerStore;
  reconcileReply: (
    entry: FeedbackLedgerEntry,
    marker: string,
  ) => Promise<FeedbackReplyReconciliation>;
  sendReply: (entry: FeedbackLedgerEntry, body: string, marker: string) => Promise<string>;
}

export interface PublishVerifiedFeedbackRepliesResult {
  publishedReplyIds: Array<{ feedbackId: string; replyId: string }>;
  unresolvedFeedbackIds: string[];
}

export class FeedbackReplyPublicationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FeedbackReplyPublicationError";
  }
}

function assertPublicationReady(options: PublishVerifiedFeedbackRepliesOptions): void {
  const head = options.publishedCommitSha;
  if (
    head !== options.observedHeadSha ||
    options.verification.projectId !== options.project.id ||
    options.verification.cardId !== options.cardId ||
    options.verification.headSha !== head
  ) {
    throw new FeedbackReplyPublicationError(
      "Verified feedback reply publication identity does not match the published current PR head",
    );
  }
  if (options.ciEvaluation.expectedHeadSha !== head) {
    throw new FeedbackReplyPublicationError(
      "Feedback reply CI observation belongs to another PR head",
    );
  }
}

function formatReply(
  head: string,
  disposition: FeedbackDisposition,
  entry: FeedbackLedgerEntry,
  pullRequestUrl: string,
  ci: CiCheckEvaluation,
  marker: string,
): string {
  const anchor =
    entry.kind === "review"
      ? `pullrequestreview-${entry.id}`
      : entry.kind === "inline-comment"
        ? `discussion_r${entry.id}`
        : `issuecomment-${entry.id}`;
  return [
    `Source: ${pullRequestUrl}#${anchor}`,
    ...(disposition.status === "verified-fixed"
      ? [
          `Verified in published commit ${head}.`,
          "Evidence:",
          ...disposition.evidence.map((item) => `- ${item}`),
        ]
      : [
          `Current published commit: ${head}.`,
          disposition.status === "uncertain"
            ? "Whether this request is fulfilled remains uncertain."
            : "This request remains unresolved.",
          `Reason: ${disposition.reason}`,
        ]),
    `Observed CI status for this head: ${ci.status}. This reply does not claim unobserved checks passed.`,
    "The human reviewer controls conversation resolution.",
    marker,
  ].join("\n");
}

function updateLedgerEntry(
  store: FeedbackLedgerStore,
  cardId: string,
  key: string,
  update: Partial<FeedbackLedgerEntry>,
): void {
  const ledger = store.read(cardId);
  if (ledger === null)
    throw new FeedbackReplyPublicationError("Feedback ledger disappeared during reply publication");
  const index = ledger.entries.findIndex((entry) => `${entry.kind}:${entry.id}` === key);
  if (index < 0)
    throw new FeedbackReplyPublicationError(`Feedback item disappeared from the ledger: ${key}`);
  const entries = [...ledger.entries];
  entries[index] = { ...entries[index]!, ...update };
  store.compareAndSwap(cardId, ledger.revision, {
    ...ledger,
    revision: ledger.revision + 1,
    updatedAt: new Date(Math.max(Date.now(), Date.parse(ledger.updatedAt) + 1)).toISOString(),
    entries,
  });
}

function recordReplyOutcome(
  options: PublishVerifiedFeedbackRepliesOptions,
  marker: string,
  replyId: string,
): void {
  const ledger = options.ledgerStore.read(options.cardId);
  if (!ledger)
    throw new FeedbackReplyPublicationError(
      "Feedback ledger disappeared during reply reconciliation",
    );
  const previous = ledger.replyOutcomes?.[marker];
  if (previous) {
    if (previous.replyId !== replyId)
      throw new FeedbackReplyPublicationError(
        "Feedback reply marker has conflicting accepted identities",
      );
    return;
  }
  const observedAt = new Date(Math.max(Date.now(), Date.parse(ledger.updatedAt) + 1)).toISOString();
  options.ledgerStore.compareAndSwap(options.cardId, ledger.revision, {
    ...ledger,
    revision: ledger.revision + 1,
    updatedAt: observedAt,
    replyOutcomes: {
      ...ledger.replyOutcomes,
      [marker]: { replyId, observedAt },
    },
  });
}

export async function publishVerifiedFeedbackReplies(
  options: PublishVerifiedFeedbackRepliesOptions,
): Promise<PublishVerifiedFeedbackRepliesResult> {
  assertPublicationReady(options);
  const ledger = options.ledgerStore.read(options.cardId);
  if (ledger === null || ledger.projectId !== options.project.id) {
    throw new FeedbackReplyPublicationError("The owning feedback ledger is missing");
  }
  const dispositions = new Map(
    options.verification.dispositions.map((item) => [item.feedbackId, item]),
  );
  const publishedReplyIds: PublishVerifiedFeedbackRepliesResult["publishedReplyIds"] = [];
  const unresolvedFeedbackIds: string[] = [];

  const knownOutcomes = new Map(
    Object.entries(ledger.replyOutcomes ?? {}).map(([marker, outcome]) => [
      marker,
      outcome.replyId,
    ]),
  );
  const uncertain = new Map(
    [...ledger.entries, ...(ledger.history ?? [])].flatMap((entry) =>
      entry.replyOperationId && ["sending", "outcome-unknown"].includes(entry.replyState ?? "")
        ? [[entry.replyOperationId, entry] as const]
        : [],
    ),
  );
  for (const [marker, entry] of uncertain) {
    if (knownOutcomes.has(marker)) continue;
    const outcome = await options.reconcileReply(entry, marker);
    if (outcome.status !== "found")
      throw new FeedbackReplyPublicationError(
        `Reply outcome remains uncertain for ${entry.kind}:${entry.id}; absence does not authorize resending`,
      );
    recordReplyOutcome(options, marker, outcome.replyId);
    knownOutcomes.set(marker, outcome.replyId);
    publishedReplyIds.push({
      feedbackId: `${entry.kind}:${entry.id}`,
      replyId: outcome.replyId,
    });
  }

  for (const entry of ledger.entries) {
    if (
      entry.actionability !== "actionable" ||
      entry.status === "published" ||
      entry.isCurrent === false
    )
      continue;
    const feedbackId = `${entry.kind}:${entry.id}`;
    const disposition = dispositions.get(feedbackId);
    if (disposition === undefined) {
      unresolvedFeedbackIds.push(feedbackId);
      continue;
    }
    if (disposition.status !== "verified-fixed") unresolvedFeedbackIds.push(feedbackId);
    const verified = disposition.status === "verified-fixed";
    const evidence = verified ? disposition.evidence : [];
    const resolution = disposition.status;
    const state = verified ? ("verified" as const) : ("escalated" as const);
    const reason = verified ? undefined : disposition.reason;
    const marker =
      entry.replyOperationId ??
      `<!-- agent-orchestrator-feedback:${encodeURIComponent(feedbackId)}:${options.publishedCommitSha}${(entry.requestRevision ?? 0) > 0 ? `:request-${entry.requestRevision}` : ""} -->`;
    const knownReplyId = knownOutcomes.get(marker);
    const reconciliation =
      knownReplyId === undefined
        ? await options.reconcileReply(entry, marker)
        : { status: "found" as const, replyId: knownReplyId };
    if (reconciliation.status === "unknown") {
      throw new FeedbackReplyPublicationError(
        `Reply outcome cannot be reconciled for ${feedbackId}: ${reconciliation.reason}`,
      );
    }
    if (reconciliation.status === "found") {
      recordReplyOutcome(options, marker, reconciliation.replyId);
      updateLedgerEntry(options.ledgerStore, options.cardId, feedbackId, {
        status: "published",
        remediationCommitSha: options.publishedCommitSha,
        replyId: reconciliation.replyId,
        replyOperationId: marker,
        replyState: "sent",
        verificationEvidence: evidence,
        resolution,
        unresolvedReason: reason,
      });
      if (!publishedReplyIds.some((item) => item.replyId === reconciliation.replyId))
        publishedReplyIds.push({ feedbackId, replyId: reconciliation.replyId });
      continue;
    }

    if (entry.replyState === "sending" || entry.replyState === "outcome-unknown") {
      throw new FeedbackReplyPublicationError(
        `Reply outcome remains uncertain for ${feedbackId}; absence does not authorize resending`,
      );
    }
    updateLedgerEntry(options.ledgerStore, options.cardId, feedbackId, {
      status: state,
      remediationCommitSha: options.publishedCommitSha,
      replyOperationId: marker,
      replyState: "sending",
      verificationEvidence: evidence,
      resolution,
      unresolvedReason: reason,
    });
    let replyId: string;
    try {
      replyId = await options.sendReply(
        entry,
        formatReply(
          options.publishedCommitSha,
          disposition,
          entry,
          options.pullRequestUrl,
          options.ciEvaluation,
          marker,
        ),
        marker,
      );
      if (replyId.trim().length === 0) throw new Error("GitHub returned an empty reply ID");
    } catch (error) {
      updateLedgerEntry(options.ledgerStore, options.cardId, feedbackId, {
        status: state,
        replyState: "outcome-unknown",
      });
      throw new FeedbackReplyPublicationError(
        `Reply outcome is uncertain for ${feedbackId}; reconciliation is required before retry`,
        { cause: error },
      );
    }
    recordReplyOutcome(options, marker, replyId);
    updateLedgerEntry(options.ledgerStore, options.cardId, feedbackId, {
      status: "published",
      remediationCommitSha: options.publishedCommitSha,
      replyId,
      replyOperationId: marker,
      replyState: "sent",
      verificationEvidence: evidence,
      resolution,
      unresolvedReason: reason,
    });
    publishedReplyIds.push({ feedbackId, replyId });
  }
  return { publishedReplyIds, unresolvedFeedbackIds };
}
