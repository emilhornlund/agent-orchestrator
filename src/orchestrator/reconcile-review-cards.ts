import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import { logger } from "../logging/logger.js";
import { removeSessionLog } from "../logging/session-log.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";
import { validateWorkflowOwnership } from "../trello/workflow-ownership.js";

import { correctCardToBacklog } from "./correct-card-state.js";
import { WorkflowError } from "./workflow-error.js";

export interface ReviewChangeRequest {
  card: TrelloCard;
  pullRequestUrl: string;
  feedback: string;
}

export interface OwnedReviewCard {
  card: TrelloCard;
  active: true;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function clearOwnershipAfterTransition(
  trello: TrelloClient,
  project: ProjectConfig,
  card: TrelloCard,
  destination: string,
): Promise<void> {
  const cardLog = logger.child({
    projectId: project.id,
    cardId: card.id,
  });

  try {
    await trello.clearWorkflowOwnership(
      card.id,
      project.trello.ownershipCustomFieldId,
    );
  } catch (error) {
    const message = getErrorMessage(error);

    cardLog.error(
      `Could not clear ownership after moving card to ${destination}: ${message}`,
    );

    throw new Error(
      `Could not clear ownership after moving card to ${destination}: ${message}`,
      { cause: error },
    );
  }
}

export async function reconcileReviewCards(
  trello: TrelloClient,
  git: GitClient,
  github: GitHubClient,
  project: ProjectConfig,
): Promise<ReviewChangeRequest | OwnedReviewCard | null> {
  const projectLog = logger.child({
    projectId: project.id,
  });

  const cards = await trello.getCards(project.trello.reviewListId, {
    workflowOwnershipCustomFieldId: project.trello.ownershipCustomFieldId,
  });

  if (cards.length === 0) {
    return null;
  }

  projectLog.info(`Reconciling ${cards.length} card(s) in Human Review...`);

  const ownedCards: TrelloCard[] = [];

  for (const card of cards) {
    const ownership = validateWorkflowOwnership(
      card,
      project,
      "implementation",
    );

    if (ownership.status !== "owned") {
      await correctCardToBacklog(
        trello,
        project,
        card,
        `Human Review card is not validly owned: ${ownership.reason}`,
      );

      continue;
    }

    ownedCards.push(card);
  }

  if (ownedCards.length > 1) {
    const cardIds = ownedCards.map((card) => card.id).join(", ");

    projectLog.error(
      `Found multiple owned cards in Human Review: ${cardIds}; blocking the project until the ambiguous state is resolved`,
    );

    throw new WorkflowError(
      "Workflow",
      `Multiple owned cards are active in Human Review: ${cardIds}`,
    );
  }

  for (const card of ownedCards) {
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
      const message = getErrorMessage(error);

      cardLog.error(
        `Could not check merged pull request for "${card.name}": ${message}`,
      );

      throw new WorkflowError(
        "Git/GitHub",
        `Could not reconcile Human Review card: ${message}`,
        { cause: error },
      );
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
        const message = getErrorMessage(error);

        cardLog.error(
          `Failed to clean up merged remote branch ${branch}: ${message}`,
        );

        throw new WorkflowError(
          "Git/GitHub",
          `Could not clean up merged pull request branch: ${message}`,
          { cause: error },
        );
      }

      try {
        await trello.moveCard(card.id, project.trello.doneListId, {
          dueComplete: true,
        });

        cardLog.event("Merged card moved to Done");

        await clearOwnershipAfterTransition(trello, project, card, "Done");

        try {
          removeSessionLog(project.id, card.id);
          cardLog.info("OpenCode session log removed");
        } catch (error) {
          cardLog.warn(
            `Failed to remove OpenCode session log: ${getErrorMessage(error)}`,
          );
        }
      } catch (error) {
        const message = getErrorMessage(error);

        cardLog.error(
          `Failed to move merged card "${card.name}" to Done: ${message}`,
        );

        throw new WorkflowError(
          "Workflow",
          `Could not complete merged Human Review card: ${message}`,
          { cause: error },
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
      const message = getErrorMessage(error);

      cardLog.error(
        `Could not check closed pull request for "${card.name}": ${message}`,
      );

      throw new WorkflowError(
        "Git/GitHub",
        `Could not reconcile Human Review card: ${message}`,
        { cause: error },
      );
    }

    if (closedPullRequest) {
      cardLog.event(
        `Human Review card has closed pull request: ${closedPullRequest.url}`,
      );

      try {
        await trello.moveCard(card.id, project.trello.failedListId);

        cardLog.event("Card with closed pull request moved to Failed");
        await clearOwnershipAfterTransition(trello, project, card, "Failed");
      } catch (error) {
        const message = getErrorMessage(error);

        cardLog.error(
          `Failed to move card "${card.name}" to Failed: ${message}`,
        );

        throw new WorkflowError(
          "Workflow",
          `Could not move closed Human Review card to Failed: ${message}`,
          { cause: error },
        );
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
          `Failed to add closed pull request comment to "${card.name}": ${getErrorMessage(error)}`,
        );
      }

      continue;
    }

    let openPullRequest;

    try {
      openPullRequest = await github.findPullRequest({
        cwd: project.repository.path,
        repository: project.repository.github,
        headBranch: branch,
      });
    } catch (error) {
      const message = getErrorMessage(error);

      cardLog.error(
        `Could not check expected open pull request for "${card.name}": ${message}`,
      );

      throw new WorkflowError(
        "Git/GitHub",
        `Could not verify expected Human Review pull request: ${message}`,
        { cause: error },
      );
    }

    if (!openPullRequest) {
      await correctCardToBacklog(
        trello,
        project,
        card,
        `Human Review card has no expected open pull request for ${branch}`,
      );

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
      const message = getErrorMessage(error);

      cardLog.error(
        `Could not check requested changes for "${card.name}": ${message}`,
      );

      throw new WorkflowError(
        "Git/GitHub",
        `Could not check Human Review requested changes: ${message}`,
        { cause: error },
      );
    }

    if (!changesRequestedPullRequest) {
      cardLog.event("Owned Human Review card remains active");

      return {
        card,
        active: true,
      };
    }

    cardLog.event(
      `Human Review card has requested changes: ${changesRequestedPullRequest.url}`,
    );

    try {
      await trello.moveCard(card.id, project.trello.workingListId);
    } catch (error) {
      const message = getErrorMessage(error);

      cardLog.error(
        `Failed to move card "${card.name}" to Working for requested changes: ${message}`,
      );

      throw new WorkflowError(
        "Workflow",
        `Could not move Human Review card to Working for requested changes: ${message}`,
        { cause: error },
      );
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
