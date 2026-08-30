import path from "node:path";

import type { ProjectConfig } from "../config/config.js";
import { cleanupWorktree } from "../git/cleanup-worktree.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import { logger } from "../logging/logger.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";
import {
  validateWorkflowOwnership,
  type WorkflowKind,
} from "../trello/workflow-ownership.js";

import { correctCardToBacklog } from "./correct-card-state.js";
import type { ReviewChangeRequest } from "./reconcile-review-cards.js";
import { WorkflowError } from "./workflow-error.js";

export interface OwnedWorkingCard {
  card: TrelloCard;
  workflow: WorkflowKind;
}

export type WorkingCardRecovery = ReviewChangeRequest | OwnedWorkingCard;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isReviewChangeRequest(
  recovery: WorkingCardRecovery,
): recovery is ReviewChangeRequest {
  return "pullRequestUrl" in recovery;
}

export async function reconcileClaimedCard(
  trello: TrelloClient,
  git: GitClient,
  github: GitHubClient,
  project: ProjectConfig,
  card: TrelloCard,
): Promise<boolean> {
  const ownership = validateWorkflowOwnership(card, project);

  if (ownership.status !== "owned") {
    return false;
  }

  const branch = `agent/${card.id}`;

  const cardLog = logger.child({
    projectId: project.id,
    cardId: card.id,
  });

  const pullRequest = await github.findPullRequest({
    cwd: project.repository.path,
    repository: project.repository.github,
    headBranch: branch,
  });

  if (!pullRequest) {
    return false;
  }

  cardLog.event(`Claimed card already has pull request: ${pullRequest.url}`);
  cardLog.event("Moving claimed card directly to Human Review...");

  await trello.moveCard(card.id, project.trello.reviewListId);

  cardLog.event("Claimed card moved directly to Human Review");

  const worktreePath = path.join(project.repository.worktreeRoot, card.id);

  try {
    await cleanupWorktree({
      git,
      project,
      worktreePath,
      branch,
    });

    cardLog.info("Reconciled claimed card local worktree cleaned up");
  } catch (error) {
    cardLog.error(
      `Claimed card moved to Human Review, but local cleanup failed: ${getErrorMessage(error)}`,
    );
  }

  return true;
}

export async function reconcileWorkingCards(
  trello: TrelloClient,
  git: GitClient,
  github: GitHubClient,
  project: ProjectConfig,
): Promise<WorkingCardRecovery | null> {
  const projectLog = logger.child({
    projectId: project.id,
  });

  const cards = await trello.getCards(project.trello.workingListId, {
    workflowOwnershipCustomFieldId: project.trello.ownershipCustomFieldId,
  });

  if (cards.length === 0) {
    return null;
  }

  projectLog.info(`Reconciling ${cards.length} card(s) in Working...`);

  const ownedCards: Array<{
    card: TrelloCard;
    workflow: WorkflowKind;
  }> = [];

  for (const card of cards) {
    const ownership = validateWorkflowOwnership(card, project);

    if (ownership.status !== "owned") {
      await correctCardToBacklog(
        trello,
        project,
        card,
        `Working card is not validly owned: ${ownership.reason}`,
      );

      continue;
    }

    ownedCards.push({
      card,
      workflow: ownership.ownership.workflow,
    });
  }

  if (ownedCards.length > 1) {
    const cardIds = ownedCards.map(({ card }) => card.id).join(", ");

    projectLog.error(
      `Found multiple owned cards in Working: ${cardIds}; blocking the project until the ambiguous state is resolved`,
    );

    throw new WorkflowError(
      "Workflow",
      `Multiple owned cards are active in Working: ${cardIds}`,
    );
  }

  for (const { card, workflow } of ownedCards) {
    const branch = `agent/${card.id}`;
    const worktreePath = path.join(project.repository.worktreeRoot, card.id);
    const cardLog = logger.child({
      projectId: project.id,
      cardId: card.id,
    });

    let pullRequest;

    try {
      pullRequest = await github.findPullRequest({
        cwd: project.repository.path,
        repository: project.repository.github,
        headBranch: branch,
      });
    } catch (error) {
      const message = getErrorMessage(error);

      cardLog.error(
        `Could not reconcile owned Working card "${card.name}": ${message}`,
      );

      throw new WorkflowError(
        "Git/GitHub",
        `Could not reconcile owned Working card: ${message}`,
        { cause: error },
      );
    }

    if (!pullRequest) {
      cardLog.event(
        `Owned Working card has no pull request; resuming ${workflow} workflow`,
      );

      return {
        card,
        workflow,
      };
    }

    if (workflow !== "implementation") {
      await correctCardToBacklog(
        trello,
        project,
        card,
        `Refinement-owned Working card has unexpected pull request ${pullRequest.url}`,
      );

      continue;
    }

    cardLog.info(`Working card already has pull request: ${pullRequest.url}`);

    let changesRequestedPullRequest;

    try {
      changesRequestedPullRequest =
        await github.findChangesRequestedPullRequest({
          cwd: project.repository.path,
          repository: project.repository.github,
          headBranch: branch,
        });
    } catch (error) {
      const message = getErrorMessage(error);

      cardLog.error(
        `Could not check requested changes while reconciling Working card "${card.name}": ${message}`,
      );

      throw new WorkflowError(
        "Git/GitHub",
        `Could not check requested changes for owned Working card: ${message}`,
        { cause: error },
      );
    }

    if (changesRequestedPullRequest) {
      cardLog.event(
        "Working card has actionable requested changes; resuming review iteration",
      );

      return {
        card,
        pullRequestUrl: changesRequestedPullRequest.url,
        feedback: changesRequestedPullRequest.feedback,
      };
    }

    cardLog.event("Moving reconciled card to Human Review...");

    try {
      await trello.moveCard(card.id, project.trello.reviewListId);
    } catch (error) {
      const message = getErrorMessage(error);

      cardLog.error(
        `Failed to move reconciled card "${card.name}" to Human Review: ${message}`,
      );

      throw new WorkflowError(
        "Workflow",
        `Could not move owned Working card to Human Review: ${message}`,
        { cause: error },
      );
    }

    cardLog.event("Reconciled card moved to Human Review");

    try {
      await cleanupWorktree({
        git,
        project,
        worktreePath,
        branch,
      });

      cardLog.info("Reconciled card local worktree cleaned up");
    } catch (error) {
      cardLog.error(
        `Reconciled card moved to Human Review, but local cleanup failed: ${getErrorMessage(error)}`,
      );
    }

    return null;
  }

  return null;
}

export function isOwnedWorkingCard(
  recovery: WorkingCardRecovery,
): recovery is OwnedWorkingCard {
  return !isReviewChangeRequest(recovery);
}
