import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import type { TrelloClient } from "../trello/trello-client.js";

export async function reconcileReviewCards(
  trello: TrelloClient,
  git: GitClient,
  github: GitHubClient,
  project: ProjectConfig,
): Promise<void> {
  const cards = await trello.getCards(project.trello.reviewListId);

  if (cards.length === 0) {
    return;
  }

  console.log(
    `[${project.id}] Reconciling ${cards.length} card(s) in Human Review...`,
  );

  for (const card of cards) {
    const branch = `agent/${card.id}`;

    let pullRequest;

    try {
      pullRequest = await github.findMergedPullRequest({
        cwd: project.repository.path,
        repository: project.repository.github,
        headBranch: branch,
      });
    } catch (error) {
      console.error(
        `[${project.id}] Could not check merged pull request for "${card.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      continue;
    }

    if (!pullRequest) {
      continue;
    }

    console.log(
      `[${project.id}] Human Review card has merged pull request: ${pullRequest.url}`,
    );

    try {
      const remoteBranchExists = await git.remoteBranchExists(
        project.repository.path,
        "origin",
        branch,
      );

      if (remoteBranchExists) {
        console.log(
          `[${project.id}] Deleting merged remote branch ${branch}...`,
        );

        await git.deleteRemoteBranch(project.repository.path, "origin", branch);

        console.log(`[${project.id}] Merged remote branch deleted`);
      }
    } catch (error) {
      console.error(
        `[${project.id}] Failed to clean up merged remote branch ${branch}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      continue;
    }

    try {
      await trello.moveCard(card.id, project.trello.doneListId);

      console.log(`[${project.id}] Merged card moved to Done`);
    } catch (error) {
      console.error(
        `[${project.id}] Failed to move merged card "${card.name}" to Done: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
