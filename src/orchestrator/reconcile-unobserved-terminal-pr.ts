import type { ProjectConfig } from "../config/config.js";
import type { GitHubClient } from "../github/github-client.js";
import type { TrelloClient } from "../trello/trello-client.js";
import { getCardsForDiscovery } from "./trello-list-discovery.js";
import { logger } from "../logging/logger.js";
import type { PrMaintenanceStore } from "../task-session/pr-maintenance-store.js";
import type { TaskExecutionStore } from "../task-session/task-execution-store.js";
import type { TaskMutationQueue } from "../task-session/task-mutation-queue.js";

/**
 * A terminal PR event may outlive its Trello card (archived, removed or moved
 * manually). Never claim such an event as a new Ready implementation, and
 * never delete a worktree when the card cannot be authoritatively located.
 * Verify the PR and original task ownership before retiring the event.
 */
export async function reconcileUnobservedTerminalPrEvents(options: {
  project: ProjectConfig;
  queue: TaskMutationQueue;
  taskStore: TaskExecutionStore;
  maintenanceStore: PrMaintenanceStore;
  github: Pick<GitHubClient, "getPullRequestStateByNumber">;
  trello: TrelloClient;
  signal: AbortSignal;
  observedReviewCardIds: readonly string[];
}): Promise<void> {
  const { project, queue, taskStore, maintenanceStore, github } = options;
  const reviewed = new Set(options.observedReviewCardIds);
  for (const mutation of queue.list()) {
    if (
      mutation.kind !== "terminal-pr" ||
      mutation.status === "completed" ||
      reviewed.has(mutation.cardId)
    )
      continue;
    const match =
      /^terminal-pr:([^:]+):(CLOSED|MERGED):([0-9a-f]{40}|[0-9a-f]{64})$/.exec(
        mutation.eventId,
      );
    if (match === null || match[1] !== mutation.cardId)
      throw new Error(
        `Orphaned terminal PR event has invalid identity: ${mutation.eventId}`,
      );
    const state = match[2] as "CLOSED" | "MERGED";
    const head = match[3]!;
    // A terminal event can be pending after the card has already moved to
    // Done/Backlog (e.g. cleanup failed). In that case the ordinary terminal
    // reconciliation must retain ownership, not treat the card as removed.
    const terminalListId =
      state === "MERGED"
        ? project.trello.doneListId
        : project.trello.backlogListId;
    const destinationCards = await getCardsForDiscovery(
      options.trello,
      project.id,
      terminalListId,
      "Could not inspect terminal PR destination before orphan retirement",
      options.signal,
    );
    if (destinationCards.some((card) => card.id === mutation.cardId)) continue;
    const record = taskStore.read(mutation.cardId);
    const originalImplementation = queue
      .list()
      .find(
        (item) =>
          item.kind === "implementation" &&
          item.projectId === project.id &&
          item.cardId === mutation.cardId &&
          item.status === "completed",
      );
    const maintenance = maintenanceStore
      .inspect()
      .find(
        (item) =>
          item.cardId === mutation.cardId && item.projectId === project.id,
      );
    const expectedOperationKey =
      record?.operationKey ?? originalImplementation?.operationKey;
    const expectedUrl =
      record?.pullRequest?.url ?? maintenance?.pullRequest.url;
    const expectedHead =
      record?.pullRequest?.headSha ?? maintenance?.expectedRemoteHead;
    const expectedNumber =
      record?.pullRequest?.number ?? maintenance?.pullRequest.number;
    if (
      mutation.projectId !== project.id ||
      expectedOperationKey === undefined ||
      expectedUrl === undefined ||
      expectedNumber === undefined ||
      expectedHead !== head ||
      mutation.operationKey !== `${expectedOperationKey}:${state}:${head}` ||
      (record === null &&
        (maintenance === undefined || originalImplementation === undefined))
    )
      throw new Error(
        `Orphaned terminal PR ${mutation.cardId} lacks verified task ownership; preserving its event`,
      );

    const pr = await github.getPullRequestStateByNumber({
      cwd: project.repository.path,
      repository: project.repository.github,
      pullRequestNumber: expectedNumber,
      project,
    });
    if (
      pr === null ||
      pr.state !== state ||
      pr.url !== expectedUrl ||
      (pr.headRefOid !== undefined && pr.headRefOid !== head) ||
      pr.headRefName !== `agent/${mutation.cardId}` ||
      pr.baseRefName !== project.repository.defaultBranch
    )
      throw new Error(
        `Orphaned terminal PR ${mutation.cardId} could not be verified on GitHub; preserving its event`,
      );

    const owned = queue.claimForRecovery(mutation.eventId);
    if (owned === null) return;
    try {
      logger
        .child({ projectId: project.id, cardId: mutation.cardId })
        .warn(
          `Verified ${state} PR has no card in Human Review; completed stale terminal queue event without moving Trello card or deleting Git worktree. Inspect preserved artifacts before manual cleanup.`,
        );
      queue.complete(owned.eventId);
    } catch (error) {
      if (queue.ownsActive(owned.eventId)) queue.fail(owned.eventId);
      throw error;
    }
  }
}
