import type { ProjectConfig } from "../config/config.js";
import type { CiCheckEvaluation } from "../github/evaluate-ci-checks.js";
import { FeedbackLedgerStore } from "./feedback-ledger-store.js";
import type { FeedbackLedgerEntry } from "./feedback-ledger.js";
import type { FeedbackVerificationResult } from "./feedback-verification.js";

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
  sendReply: (
    entry: FeedbackLedgerEntry,
    body: string,
    marker: string,
  ) => Promise<string>;
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

function assertPublicationReady(
  options: PublishVerifiedFeedbackRepliesOptions,
): void {
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
  if (
    options.ciEvaluation.status !== "passed" ||
    options.ciEvaluation.expectedHeadSha !== head
  ) {
    throw new FeedbackReplyPublicationError(
      "Complete current-head CI evidence has not passed; feedback replies cannot be published",
    );
  }
}

function formatReply(
  head: string,
  evidence: readonly string[],
  marker: string,
): string {
  return [
    `Verified in published commit ${head}.`,
    "Evidence:",
    ...evidence.map((item) => `- ${item}`),
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
    throw new FeedbackReplyPublicationError(
      "Feedback ledger disappeared during reply publication",
    );
  const index = ledger.entries.findIndex(
    (entry) => `${entry.kind}:${entry.id}` === key,
  );
  if (index < 0)
    throw new FeedbackReplyPublicationError(
      `Feedback item disappeared from the ledger: ${key}`,
    );
  const entries = [...ledger.entries];
  entries[index] = { ...entries[index]!, ...update };
  store.compareAndSwap(cardId, ledger.revision, {
    ...ledger,
    revision: ledger.revision + 1,
    updatedAt: new Date(
      Math.max(Date.now(), Date.parse(ledger.updatedAt) + 1),
    ).toISOString(),
    entries,
  });
}

export async function publishVerifiedFeedbackReplies(
  options: PublishVerifiedFeedbackRepliesOptions,
): Promise<PublishVerifiedFeedbackRepliesResult> {
  assertPublicationReady(options);
  const ledger = options.ledgerStore.read(options.cardId);
  if (ledger === null || ledger.projectId !== options.project.id) {
    throw new FeedbackReplyPublicationError(
      "The owning feedback ledger is missing",
    );
  }
  const dispositions = new Map(
    options.verification.dispositions.map((item) => [item.feedbackId, item]),
  );
  const publishedReplyIds: PublishVerifiedFeedbackRepliesResult["publishedReplyIds"] =
    [];
  const unresolvedFeedbackIds: string[] = [];

  for (const entry of ledger.entries) {
    if (entry.actionability !== "actionable" || entry.status === "published")
      continue;
    const feedbackId = `${entry.kind}:${entry.id}`;
    const disposition = dispositions.get(feedbackId);
    if (disposition === undefined || disposition.status === "unresolved") {
      unresolvedFeedbackIds.push(feedbackId);
      continue;
    }
    if (
      (entry.kind === "inline-comment" && entry.threadId === undefined) ||
      entry.kind === "review"
    ) {
      unresolvedFeedbackIds.push(feedbackId);
      continue;
    }
    const marker = `<!-- agent-orchestrator-feedback:${encodeURIComponent(feedbackId)}:${options.publishedCommitSha} -->`;
    const reconciliation = await options.reconcileReply(entry, marker);
    if (reconciliation.status === "unknown") {
      throw new FeedbackReplyPublicationError(
        `Reply outcome cannot be reconciled for ${feedbackId}: ${reconciliation.reason}`,
      );
    }
    if (reconciliation.status === "found") {
      updateLedgerEntry(options.ledgerStore, options.cardId, feedbackId, {
        status: "published",
        remediationCommitSha: options.publishedCommitSha,
        replyId: reconciliation.replyId,
        replyOperationId: marker,
        replyState: "sent",
        verificationEvidence: disposition.evidence,
      });
      publishedReplyIds.push({ feedbackId, replyId: reconciliation.replyId });
      continue;
    }

    updateLedgerEntry(options.ledgerStore, options.cardId, feedbackId, {
      status: "verified",
      remediationCommitSha: options.publishedCommitSha,
      replyOperationId: marker,
      replyState: "sending",
      verificationEvidence: disposition.evidence,
    });
    let replyId: string;
    try {
      replyId = await options.sendReply(
        entry,
        formatReply(options.publishedCommitSha, disposition.evidence, marker),
        marker,
      );
      if (replyId.trim().length === 0)
        throw new Error("GitHub returned an empty reply ID");
    } catch (error) {
      updateLedgerEntry(options.ledgerStore, options.cardId, feedbackId, {
        status: "verified",
        replyState: "outcome-unknown",
      });
      throw new FeedbackReplyPublicationError(
        `Reply outcome is uncertain for ${feedbackId}; reconciliation is required before retry`,
        { cause: error },
      );
    }
    updateLedgerEntry(options.ledgerStore, options.cardId, feedbackId, {
      status: "published",
      remediationCommitSha: options.publishedCommitSha,
      replyId,
      replyOperationId: marker,
      replyState: "sent",
      verificationEvidence: disposition.evidence,
    });
    publishedReplyIds.push({ feedbackId, replyId });
  }
  return { publishedReplyIds, unresolvedFeedbackIds };
}
