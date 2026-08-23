import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import { logger } from "../logging/logger.js";
import { removeSessionLog } from "../logging/session-log.js";
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
  const projectLog = logger.child({
    projectId: project.id,
  });

  const cards = await trello.getCards(project.trello.reviewListId);

  if (cards.length === 0) {
    return null;
  }

  projectLog.info(`Reconciling ${cards.length} card(s) in Human Review...`);

  for (const card of cards) {
    const branch = `agent/${card.id}`;

    const cardLog = logger.child({
      projectId: project.id,
      cardId: card.id,
    });

    let mergedPullRequest;

    try {
      mergedPullRequest = await github.findMergedPullRequest({
        cwd: project.repository.path,
        repository: project.repository.github,
        headBranch: branch,
      });
    } catch (error) {
      cardLog.error(
        `Could not check merged pull request for "${card.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      continue;
    }

    if (mergedPullRequest) {
      cardLog.event(
        `Human Review card has merged pull request: ${mergedPullRequest.url}`,
      );

      try {
        const remoteBranchExists = await git.remoteBranchExists(
          project.repository.path,
          "origin",
          branch,
        );

        if (remoteBranchExists) {
          cardLog.info(`Deleting merged remote branch ${branch}...`);

          await git.deleteRemoteBranch(
            project.repository.path,
            "origin",
            branch,
          );

          cardLog.info("Merged remote branch deleted");
        }
      } catch (error) {
        cardLog.error(
          `Failed to clean up merged remote branch ${branch}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );

        continue;
      }

      try {
        await trello.moveCard(card.id, project.trello.doneListId, {
          dueComplete: true,
        });

        cardLog.event("Merged card moved to Done");

        try {
          removeSessionLog(project.id, card.id);
          cardLog.info("OpenCode session log removed");
        } catch (error) {
          cardLog.warn(
            `Failed to remove OpenCode session log: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      } catch (error) {
        cardLog.error(
          `Failed to move merged card "${card.name}" to Done: ${
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
      cardLog.error(
        `Could not check closed pull request for "${card.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      continue;
    }

    if (closedPullRequest) {
      cardLog.event(
        `Human Review card has closed pull request: ${closedPullRequest.url}`,
      );

      try {
        await trello.moveCard(card.id, project.trello.failedListId);

        cardLog.event("Card with closed pull request moved to Failed");
      } catch (error) {
        cardLog.error(
          `Failed to move card "${card.name}" to Failed: ${
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
        cardLog.error(
          `Failed to add closed pull request comment to "${card.name}": ${
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
      cardLog.error(
        `Could not check requested changes for "${card.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      continue;
    }

    if (!changesRequestedPullRequest) {
      continue;
    }

    cardLog.event(
      `Human Review card has requested changes: ${changesRequestedPullRequest.url}`,
    );

    try {
      await trello.moveCard(card.id, project.trello.workingListId);
    } catch (error) {
      cardLog.error(
        `Failed to move card "${card.name}" to Working for requested changes: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      continue;
    }

    cardLog.event("Card with requested changes moved to Working");

    return {
      card,
      pullRequestUrl: changesRequestedPullRequest.url,
      feedback: changesRequestedPullRequest.feedback,
    };
  }

  return null;
}
