import path from "node:path";

import type { ProjectConfig } from "../config/config.js";
import { cleanupWorktree } from "../git/cleanup-worktree.js";
import { getExistingWorktree } from "../git/prepare-worktree.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import { logger } from "../logging/logger.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";
import {
  notifyHumanReview,
  type EmailNotifier,
} from "../notifications/email-notifier.js";

import { correctCardToBacklog } from "./correct-card-state.js";
import type { ReviewChangeRequest } from "./reconcile-review-cards.js";
import { getWorkflowKind, type WorkflowKind } from "./workflow-kind.js";
import { WorkflowError } from "./workflow-error.js";

export interface WorkingCard {
  card: TrelloCard;
  workflow: WorkflowKind;
}

export type WorkingCardRecovery = ReviewChangeRequest | WorkingCard;

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
  emailNotifier?: EmailNotifier,
): Promise<boolean> {
  const branch = `agent/${card.id}`;
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

    throw new WorkflowError(
      "Git/GitHub",
      `Could not reconcile claimed Working card: ${message}`,
      { cause: error },
    );
  }

  if (!pullRequest) {
    return false;
  }

  cardLog.event(`Claimed card already has pull request: ${pullRequest.url}`);
  cardLog.event("Moving claimed card directly to Human Review...");

  await trello.moveCard(card.id, project.trello.reviewListId);

  cardLog.event("Claimed card moved directly to Human Review");

  await notifyHumanReview(
    emailNotifier,
    {
      project,
      card,
      pullRequestUrl: pullRequest.url,
      commitSha: "Not available during reconciliation",
      reviewResult: "Not run during reconciliation",
      remediationResult: "Not run during reconciliation",
      publicationContext:
        "An existing pull request was found during reconciliation and the claimed card was moved directly to Human Review.",
    },
    cardLog,
  );

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
  emailNotifier?: EmailNotifier,
): Promise<WorkingCardRecovery | null> {
  const projectLog = logger.child({
    projectId: project.id,
  });

  const cards = await trello.getCards(project.trello.workingListId);

  if (cards.length === 0) {
    return null;
  }

  projectLog.info(`Reconciling ${cards.length} card(s) in Working...`);

  const recoverableCards: WorkingCardRecovery[] = [];

  for (const card of cards) {
    const transition = await trello.getLatestListTransition(
      card.id,
      project.trello.workingListId,
    );

    if (transition === null) {
      await correctCardToBacklog(
        trello,
        project,
        card,
        "Working card has no recorded transition into Working",
      );

      continue;
    }

    if (transition.listBeforeId === project.trello.readyListId) {
      const workflow = getWorkflowKind(card, project);

      if (workflow === null) {
        await correctCardToBacklog(
          trello,
          project,
          card,
          "Working card has no configured workflow label",
        );

        continue;
      }

      const worktree = await getExistingWorktree(git, project, card.id);

      if (worktree === null) {
        await correctCardToBacklog(
          trello,
          project,
          card,
          `Working card has no valid ${worktreePathForLog(project, card.id)} worktree on agent/${card.id}`,
        );

        continue;
      }

      const recovery = await reconcileReadyWorkingCard(
        trello,
        git,
        github,
        project,
        card,
        workflow,
        emailNotifier,
      );

      if (recovery !== null) {
        recoverableCards.push(recovery);
      }

      continue;
    }

    if (transition.listBeforeId === project.trello.reviewListId) {
      const recovery = await reconcileReviewToWorkingCard(
        trello,
        github,
        project,
        card,
      );

      if (recovery !== null) {
        recoverableCards.push(recovery);
      }

      continue;
    }

    await correctCardToBacklog(
      trello,
      project,
      card,
      `Working card was moved from ${transition.listBeforeId}, not an eligible workflow list`,
    );
  }

  if (recoverableCards.length > 1) {
    const cardIds = recoverableCards
      .map((recovery) => recovery.card.id)
      .join(", ");

    projectLog.error(
      `Found multiple active cards in Working: ${cardIds}; blocking the project until the ambiguous state is resolved`,
    );

    throw new WorkflowError(
      "Workflow",
      `Multiple active cards are in Working: ${cardIds}`,
    );
  }

  return recoverableCards[0] ?? null;
}

async function reconcileReadyWorkingCard(
  trello: TrelloClient,
  git: GitClient,
  github: GitHubClient,
  project: ProjectConfig,
  card: TrelloCard,
  workflow: WorkflowKind,
  emailNotifier?: EmailNotifier,
): Promise<WorkingCardRecovery | null> {
  const branch = `agent/${card.id}`;
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

    throw new WorkflowError(
      "Git/GitHub",
      `Could not reconcile Working card: ${message}`,
      { cause: error },
    );
  }

  if (!pullRequest) {
    cardLog.event(`Resuming ${workflow} workflow from its existing worktree`);

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
      `Refinement Working card has unexpected pull request ${pullRequest.url}`,
    );

    return null;
  }

  let changesRequestedPullRequest;

  try {
    changesRequestedPullRequest = await github.findChangesRequestedPullRequest({
      cwd: project.repository.path,
      repository: project.repository.github,
      headBranch: branch,
    });
  } catch (error) {
    const message = getErrorMessage(error);

    throw new WorkflowError(
      "Git/GitHub",
      `Could not check requested changes for Working card: ${message}`,
      { cause: error },
    );
  }

  if (changesRequestedPullRequest) {
    cardLog.event("Working card has actionable requested changes");

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

    throw new WorkflowError(
      "Workflow",
      `Could not move Working card to Human Review: ${message}`,
      { cause: error },
    );
  }

  cardLog.event("Reconciled card moved to Human Review");

  await notifyHumanReview(
    emailNotifier,
    {
      project,
      card,
      pullRequestUrl: pullRequest.url,
      commitSha: "Not available during reconciliation",
      reviewResult: "Not run during reconciliation",
      remediationResult: "Not run during reconciliation",
      publicationContext:
        "An existing pull request was found during reconciliation and the Working card was moved to Human Review.",
    },
    cardLog,
  );

  try {
    await cleanupWorktree({
      git,
      project,
      worktreePath: path.join(project.repository.worktreeRoot, card.id),
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

async function reconcileReviewToWorkingCard(
  trello: TrelloClient,
  github: GitHubClient,
  project: ProjectConfig,
  card: TrelloCard,
): Promise<ReviewChangeRequest | null> {
  const branch = `agent/${card.id}`;
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

    throw new WorkflowError(
      "Git/GitHub",
      `Could not reconcile Working card moved from Human Review: ${message}`,
      { cause: error },
    );
  }

  if (!pullRequest) {
    await correctCardToBacklog(
      trello,
      project,
      card,
      `Working card moved from Human Review without an expected open pull request for ${branch}`,
    );

    return null;
  }

  let changesRequestedPullRequest;

  try {
    changesRequestedPullRequest = await github.findChangesRequestedPullRequest({
      cwd: project.repository.path,
      repository: project.repository.github,
      headBranch: branch,
    });
  } catch (error) {
    const message = getErrorMessage(error);

    throw new WorkflowError(
      "Git/GitHub",
      `Could not check requested changes for Working card moved from Human Review: ${message}`,
      { cause: error },
    );
  }

  if (!changesRequestedPullRequest) {
    await correctCardToBacklog(
      trello,
      project,
      card,
      `Working card moved from Human Review without actionable requested changes on ${pullRequest.url}`,
    );

    return null;
  }

  cardLog.event("Working card has actionable requested changes");

  return {
    card,
    pullRequestUrl: changesRequestedPullRequest.url,
    feedback: changesRequestedPullRequest.feedback,
  };
}

function worktreePathForLog(project: ProjectConfig, cardId: string): string {
  return path.join(project.repository.worktreeRoot, cardId);
}

export function isImplementationWorkingCard(
  recovery: WorkingCardRecovery,
): recovery is WorkingCard {
  return !isReviewChangeRequest(recovery);
}
