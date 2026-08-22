import path from "node:path";

import type { ProjectConfig } from "../config/config.js";
import { cleanupWorktree } from "../git/cleanup-worktree.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import type { TrelloClient } from "../trello/trello-client.js";

export async function reconcileWorkingCards(
  trello: TrelloClient,
  git: GitClient,
  github: GitHubClient,
  project: ProjectConfig,
): Promise<void> {
  const cards = await trello.getCards(project.trello.workingListId);

  if (cards.length === 0) {
    return;
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
        `[${project.id}] Working card is stranded with no open pull request: ${card.name} (${card.id})`,
      );

      continue;
    }

    console.log(
      `[${project.id}] Working card already has pull request: ${pullRequest.url}`,
    );
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
}
