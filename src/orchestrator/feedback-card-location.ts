import type { ProjectConfig } from "../config/config.js";
import type { GitHubClient } from "../github/github-client.js";
import type { TrelloClient } from "../trello/trello-client.js";
import type { TaskExecutionStore } from "../task-session/task-execution-store.js";
import { expectedTaskTrelloList } from "../task-session/reconcile-task-session.js";
import { verifyExistingPrOpen } from "./verify-existing-pr-open.js";

export interface FeedbackCardLocationOptions {
  project: ProjectConfig;
  cardId: string;
  taskStore: TaskExecutionStore;
  trello: TrelloClient;
  github: GitHubClient;
}

/** Persist the intended list transition before dispatch. Internal execution phase
 * is not evidence of the card's expected physical location. Older published
 * corrections retain their Review expectation until a verified new transition. */
export async function prepareFeedbackCardMove(
  options: FeedbackCardLocationOptions,
  toListId: string,
  operationId: string,
): Promise<void> {
  const record = options.taskStore.read(options.cardId);
  if (!record?.pullRequest)
    throw new Error("Feedback card transition requires the existing owned PR");
  if (
    ![options.project.trello.workingListId, options.project.trello.reviewListId].includes(toListId)
  )
    throw new Error("Feedback card transition has an invalid destination");
  if (record.feedbackCardMove) {
    if (
      record.feedbackCardMove.toListId !== toListId ||
      record.feedbackCardMove.operationId !== operationId
    )
      throw new Error("An earlier feedback card transition must be reconciled first");
    return;
  }
  const fromListId = expectedTaskTrelloList(options.project, record);
  if (
    ![options.project.trello.workingListId, options.project.trello.reviewListId].includes(
      fromListId,
    )
  )
    throw new Error("Feedback card transition has an invalid source list");
  const card = await options.trello.getCard(options.cardId);
  if (card.id !== options.cardId) throw new Error("Feedback card lookup has a mismatched identity");
  if (card.idList !== fromListId)
    throw new Error("Feedback card moved unexpectedly; preserving the current checkpoint");
  if (fromListId === toListId) return;
  options.taskStore.compareAndSwap(record.cardId, record.revision, {
    ...record,
    expectedTrelloListId: fromListId,
    feedbackCardMove: { operationId, fromListId, toListId },
    revision: record.revision + 1,
    updatedAt: new Date(Math.max(Date.now(), Date.parse(record.updatedAt) + 1)).toISOString(),
  });
}

export async function reconcilePendingFeedbackCardMove(
  options: FeedbackCardLocationOptions,
): Promise<void> {
  const record = options.taskStore.read(options.cardId);
  const move = record?.feedbackCardMove;
  if (!record || !move || !record.pullRequest) return;
  if (
    ![move.fromListId, move.toListId].every((list) =>
      [options.project.trello.workingListId, options.project.trello.reviewListId].includes(list),
    )
  )
    throw new Error("Pending feedback card transition has invalid list identities");
  await verifyExistingPrOpen({
    project: options.project,
    github: options.github,
    cardId: record.cardId,
    branch: record.expectedBranch ?? `agent/${record.cardId}`,
    pullRequestUrl: record.pullRequest.url,
  });
  const card = await options.trello.getCard(record.cardId);
  if (card.id !== record.cardId) throw new Error("Feedback card lookup has a mismatched identity");
  if (card.idList !== move.fromListId && card.idList !== move.toListId)
    throw new Error("Feedback card moved unexpectedly during its pending transition");
  if (card.idList !== move.toListId) await options.trello.moveCard(record.cardId, move.toListId);
  const confirmed = await options.trello.getCard(record.cardId);
  if (confirmed.id !== record.cardId || confirmed.idList !== move.toListId)
    throw new Error("Feedback card transition was not verified");
  const latest = options.taskStore.read(record.cardId);
  if (
    !latest ||
    latest.feedbackCardMove?.operationId !== move.operationId ||
    latest.feedbackCardMove.fromListId !== move.fromListId ||
    latest.feedbackCardMove.toListId !== move.toListId
  )
    throw new Error("Feedback card transition ownership changed during verification");
  options.taskStore.compareAndSwap(record.cardId, latest.revision, {
    ...latest,
    expectedTrelloListId: move.toListId,
    feedbackCardMove: undefined,
    revision: latest.revision + 1,
    updatedAt: new Date(Math.max(Date.now(), Date.parse(latest.updatedAt) + 1)).toISOString(),
  });
}

export async function ensureFeedbackCardLocation(
  options: FeedbackCardLocationOptions,
  toListId: string,
  operationId: string,
): Promise<void> {
  await prepareFeedbackCardMove(options, toListId, operationId);
  await reconcilePendingFeedbackCardMove(options);
}
