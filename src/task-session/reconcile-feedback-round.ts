import type { FeedbackLedgerEntry, FeedbackLedger } from "./feedback-ledger.js";
import { FeedbackLedgerStore } from "./feedback-ledger-store.js";

export interface ReconcileFeedbackRoundInput {
  store: FeedbackLedgerStore;
  projectId: string;
  cardId: string;
  previousHeadSha: string;
  observedHeadSha: string;
  newlyObservedFeedback: readonly FeedbackLedgerEntry[];
}

export interface FeedbackRoundReconciliation {
  ledger: FeedbackLedger;
  headChanged: boolean;
  feedbackChanged: boolean;
  evidenceStillValid: boolean;
  newActionableFeedbackIds: string[];
  remainingActionableFeedbackIds: string[];
  noNewActionableFeedback: boolean;
}

function feedbackIdentity(entry: FeedbackLedgerEntry): string {
  return JSON.stringify({
    kind: entry.kind,
    id: entry.id,
    author: entry.author,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    body: entry.body,
    commitSha: entry.commitSha ?? null,
    headSha: entry.headSha ?? null,
    path: entry.path ?? null,
    line: entry.line ?? null,
    threadId: entry.threadId ?? null,
    isResolved: entry.isResolved ?? null,
    isOutdated: entry.isOutdated ?? null,
  });
}

function pendingActionableIds(
  entries: readonly FeedbackLedgerEntry[],
): Set<string> {
  return new Set(
    entries
      .filter(
        (entry) =>
          entry.actionability === "actionable" &&
          entry.status === "pending" &&
          entry.isResolved !== true &&
          entry.isOutdated !== true,
      )
      .map((entry) => `${entry.kind}:${entry.id}`),
  );
}

export function reconcileFeedbackRound(
  input: ReconcileFeedbackRoundInput,
): FeedbackRoundReconciliation {
  const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
  if (
    !shaPattern.test(input.previousHeadSha) ||
    !shaPattern.test(input.observedHeadSha)
  ) {
    throw new Error(
      "Feedback round reconciliation requires valid observed PR head SHAs",
    );
  }
  const previous = input.store.read(input.cardId);
  if (
    previous === null ||
    previous.projectId !== input.projectId ||
    previous.cardId !== input.cardId
  ) {
    throw new Error(
      "Feedback round reconciliation requires the owning persisted ledger",
    );
  }
  const previousActionable = pendingActionableIds(previous.entries);
  const merged = input.store.mergeIncoming(
    input.cardId,
    input.newlyObservedFeedback,
  );
  let ledger = merged;
  const closed = merged.entries.map((entry) => {
    if (entry.isResolved !== true && entry.isOutdated !== true) return entry;
    return {
      ...entry,
      actionability: "not-actionable" as const,
      ...(entry.status === "pending" ? { status: "closed" as const } : {}),
    };
  });
  if (closed.some((entry, index) => entry !== merged.entries[index])) {
    ledger = input.store.compareAndSwap(input.cardId, merged.revision, {
      ...merged,
      revision: merged.revision + 1,
      updatedAt: new Date(
        Math.max(Date.now(), Date.parse(merged.updatedAt) + 1),
      ).toISOString(),
      entries: closed,
    });
  }
  const remaining = pendingActionableIds(ledger.entries);
  const newActionableFeedbackIds = [...remaining].filter(
    (id) => !previousActionable.has(id),
  );
  const feedbackChanged =
    previous.entries.length !== ledger.entries.length ||
    previous.entries.some((entry) => {
      const after = ledger.entries.find(
        (candidate) =>
          candidate.kind === entry.kind && candidate.id === entry.id,
      );
      return (
        after === undefined ||
        feedbackIdentity(after) !== feedbackIdentity(entry)
      );
    });
  const headChanged = input.previousHeadSha !== input.observedHeadSha;
  return {
    ledger,
    headChanged,
    feedbackChanged,
    evidenceStillValid: !headChanged && !feedbackChanged,
    newActionableFeedbackIds,
    remainingActionableFeedbackIds: [...remaining],
    noNewActionableFeedback: newActionableFeedbackIds.length === 0,
  };
}
