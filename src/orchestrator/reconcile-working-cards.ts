import path from "node:path";

import type { ProjectConfig } from "../config/config.js";
import { cleanupWorktree } from "../git/cleanup-worktree.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
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

  const pullRequest = await github.findPullRequest({
    cwd: project.repository.path,
    repository: project.repository.github,
    headBranch: branch,
  });

  if (!pullRequest) {
    return false;
  }

  console.log(
    `[${project.id}] Claimed card already has pull request: ${pullRequest.url}`,
  );
  console.log(
    `[${project.id}] Moving claimed card directly to Human Review...`,
  );

  await trello.moveCard(card.id, project.trello.reviewListId);

  console.log(`[${project.id}] Claimed card moved directly to Human Review`);

  const worktreePath = path.join(project.repository.worktreeRoot, card.id);

  try {
    await cleanupWorktree({
      git,
      project,
      worktreePath,
      branch,
    });

    console.log(
      `[${project.id}] Reconciled claimed card local worktree cleaned up`,
    );
  } catch (error) {
    console.error(
      `[${project.id}] Claimed card moved to Human Review, but local cleanup failed: ${
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
  const cards = await trello.getCards(project.trello.workingListId);

  if (cards.length === 0) {
    return null;
  }

  console.log(
    `[${project.id}] Reconciling ${cards.length} card(s) in Working...`,
  );

  for (const card of cards) {
    const branch = `agent/${card.id}`;
    const worktreePath = path.join(project.repository.worktreeRoot, card.id);

    let pullRequest;

    try {
      pullRequest = await github.findPullRequest({
        cwd: project.repository.path,
        repository: project.repository.github,
        headBranch: branch,
      });
    } catch (error) {
      console.error(
        `[${project.id}] Could not reconcile Working card "${card.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      continue;
    }

    if (!pullRequest) {
      console.warn(
        `[${project.id}] Working card has no open pull request; moving to Failed: ${card.name} (${card.id})`,
      );

      try {
        await trello.moveCard(card.id, project.trello.failedListId);

        console.log(`[${project.id}] Stranded Working card moved to Failed`);
      } catch (error) {
        console.error(
          `[${project.id}] Failed to move stranded Working card "${card.name}" to Failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      continue;
    }

    console.log(
      `[${project.id}] Working card already has pull request: ${pullRequest.url}`,
    );

    let changesRequestedPullRequest;

    try {
      changesRequestedPullRequest =
        await github.findChangesRequestedPullRequest({
          cwd: project.repository.path,
          repository: project.repository.github,
          headBranch: branch,
        });
    } catch (error) {
      console.error(
        `[${project.id}] Could not check requested changes while reconciling Working card "${card.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      continue;
    }

    if (changesRequestedPullRequest) {
      console.log(
        `[${project.id}] Working card has actionable requested changes; resuming review iteration`,
      );

      return {
        card,
        pullRequestUrl: changesRequestedPullRequest.url,
        feedback: changesRequestedPullRequest.feedback,
      };
    }

    console.log(`[${project.id}] Moving reconciled card to Human Review...`);

    try {
      await trello.moveCard(card.id, project.trello.reviewListId);
    } catch (error) {
      console.error(
        `[${project.id}] Failed to move reconciled card "${card.name}" to Human Review: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      continue;
    }

    console.log(`[${project.id}] Reconciled card moved to Human Review`);

    try {
      await cleanupWorktree({
        git,
        project,
        worktreePath,
        branch,
      });

      console.log(`[${project.id}] Reconciled card local worktree cleaned up`);
    } catch (error) {
      console.error(
        `[${project.id}] Reconciled card moved to Human Review, but local cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return null;
}
