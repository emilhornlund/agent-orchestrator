import path from "node:path";

import type { ProjectConfig } from "../config/config.js";
import { cleanupWorktree } from "../git/cleanup-worktree.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import { logger } from "../logging/logger.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";

import type { ReviewChangeRequest } from "./reconcile-review-cards.js";

export async function reconcileClaimedCard(
  trello: TrelloClient,
  git: GitClient,
  github: GitHubClient,
  project: ProjectConfig,
  card: TrelloCard,
): Promise<boolean> {
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
      `Claimed card moved to Human Review, but local cleanup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return true;
}

export async function reconcileWorkingCards(
  trello: TrelloClient,
  git: GitClient,
  github: GitHubClient,
  project: ProjectConfig,
): Promise<ReviewChangeRequest | null> {
  const projectLog = logger.child({
    projectId: project.id,
  });

  const cards = await trello.getCards(project.trello.workingListId);

  if (cards.length === 0) {
    return null;
  }

  projectLog.info(`Reconciling ${cards.length} card(s) in Working...`);

  for (const card of cards) {
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
      cardLog.error(
        `Could not reconcile Working card "${card.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      continue;
    }

    if (!pullRequest) {
      cardLog.warn(
        `Working card has no open pull request; moving to Failed: ${card.name}`,
      );

      try {
        await trello.moveCard(card.id, project.trello.failedListId);

        cardLog.event("Stranded Working card moved to Failed");
      } catch (error) {
        cardLog.error(
          `Failed to move stranded Working card "${card.name}" to Failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

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
      cardLog.error(
        `Could not check requested changes while reconciling Working card "${card.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      continue;
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
      cardLog.error(
        `Failed to move reconciled card "${card.name}" to Human Review: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      continue;
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
        `Reconciled card moved to Human Review, but local cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return null;
}
