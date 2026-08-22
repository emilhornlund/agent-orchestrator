import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";

export interface ReviewChangeRequest {
  card: TrelloCard;
  pullRequestUrl: string;
  feedback: string;
}

export async function reconcileReviewCards(
  trello: TrelloClient,
  git: GitClient,
  github: GitHubClient,
  project: ProjectConfig,
): Promise<ReviewChangeRequest | null> {
  const cards = await trello.getCards(project.trello.reviewListId);

  if (cards.length === 0) {
    return null;
  }

  console.log(
    `[${project.id}] Reconciling ${cards.length} card(s) in Human Review...`,
  );

  for (const card of cards) {
    const branch = `agent/${card.id}`;

    let mergedPullRequest;

    try {
      mergedPullRequest = await github.findMergedPullRequest({
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

    if (mergedPullRequest) {
      console.log(
        `[${project.id}] Human Review card has merged pull request: ${mergedPullRequest.url}`,
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

          await git.deleteRemoteBranch(
            project.repository.path,
            "origin",
            branch,
          );

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

      continue;
    }

    let closedPullRequest;

    try {
      closedPullRequest = await github.findClosedPullRequest({
        cwd: project.repository.path,
        repository: project.repository.github,
        headBranch: branch,
      });
    } catch (error) {
      console.error(
        `[${project.id}] Could not check closed pull request for "${card.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      continue;
    }

    if (closedPullRequest) {
      console.log(
        `[${project.id}] Human Review card has closed pull request: ${closedPullRequest.url}`,
      );

      try {
        await trello.moveCard(card.id, project.trello.failedListId);

        console.log(
          `[${project.id}] Card with closed pull request moved to Failed`,
        );
      } catch (error) {
        console.error(
          `[${project.id}] Failed to move card "${card.name}" to Failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );

        continue;
      }

      try {
        await trello.addComment(
          card.id,
          [
            "Pull request was closed without being merged.",
            "",
            `Pull request: ${closedPullRequest.url}`,
          ].join("\n"),
        );
      } catch (error) {
        console.error(
          `[${project.id}] Failed to add closed pull request comment to "${card.name}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      continue;
    }

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
        `[${project.id}] Could not check requested changes for "${card.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      continue;
    }

    if (!changesRequestedPullRequest) {
      continue;
    }

    console.log(
      `[${project.id}] Human Review card has requested changes: ${changesRequestedPullRequest.url}`,
    );

    try {
      await trello.moveCard(card.id, project.trello.workingListId);
    } catch (error) {
      console.error(
        `[${project.id}] Failed to move card "${card.name}" to Working for requested changes: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      continue;
    }

    console.log(`[${project.id}] Card with requested changes moved to Working`);

    return {
      card,
      pullRequestUrl: changesRequestedPullRequest.url,
      feedback: changesRequestedPullRequest.feedback,
    };
  }

  return null;
}
