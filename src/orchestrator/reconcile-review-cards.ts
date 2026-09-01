import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import type {
  GitHubClient,
  PullRequestState,
} from "../github/github-client.js";
import { logger } from "../logging/logger.js";
import { removeSessionLog } from "../logging/session-log.js";
import {
  notifyCompletion,
  notifyFailed,
  type EmailNotifier,
} from "../notifications/email-notifier.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";

import { correctCardToBacklog } from "./correct-card-state.js";
import {
  annotateCardFailure,
  annotateFailure,
  getExistingSessionLogPath,
} from "./failure-diagnostic.js";
import { WorkflowError } from "./workflow-error.js";

export interface ReviewChangeRequest {
  card: TrelloCard;
  pullRequestUrl: string;
  feedback: string;
}

export interface ActiveReviewCard {
  card: TrelloCard;
  active: true;
}

interface ReviewCardState {
  card: TrelloCard;
  branch: string;
  pullRequest: PullRequestState;
  changesRequested?: ReviewChangeRequest;
}

interface ReconcileReviewCardsOptions {
  moveRequestedChanges?: boolean;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function reconcileReviewCards(
  trello: TrelloClient,
  git: GitClient,
  github: GitHubClient,
  project: ProjectConfig,
  options: ReconcileReviewCardsOptions = {},
  emailNotifier?: EmailNotifier,
  signal?: AbortSignal,
): Promise<ReviewChangeRequest | ActiveReviewCard | null> {
  if (signal?.aborted) {
    return null;
  }

  const projectLog = logger.child({
    projectId: project.id,
  });

  let cards: TrelloCard[];

  try {
    cards = await trello.getCards(project.trello.reviewListId);
  } catch (error) {
    if (error instanceof Error) {
      annotateFailure(error, { projectId: project.id });
    }

    throw error;
  }

  if (signal?.aborted) {
    return null;
  }

  if (cards.length === 0) {
    return null;
  }

  projectLog.info(`Reconciling ${cards.length} card(s) in Human Review...`);

  const states: ReviewCardState[] = [];

  for (const card of cards) {
    if (signal?.aborted) {
      return null;
    }

    const state = await inspectReviewCard(github, project, card, signal);

    if (signal?.aborted) {
      return null;
    }

    if (state === null) {
      await correctCardToBacklog(
        trello,
        project,
        card,
        `Human Review card has no expected pull request for agent/${card.id}`,
        signal,
      );

      if (signal?.aborted) {
        return null;
      }

      continue;
    }

    states.push(state);
  }

  const activeStates = states.filter((state) => !isTerminalReviewState(state));

  if (signal?.aborted) {
    return null;
  }

  if (activeStates.length > 1) {
    const cardIds = activeStates.map((state) => state.card.id).join(", ");

    projectLog.error(
      `Found multiple active cards in Human Review: ${cardIds}; blocking the project until the ambiguous state is resolved`,
    );

    const reconciliationError = new WorkflowError(
      "Workflow",
      `Multiple active cards are in Human Review: ${cardIds}`,
    );

    annotateFailure(reconciliationError, {
      projectId: project.id,
      cardIds: activeStates.map((state) => state.card.id),
      sessionLogPaths: activeStates
        .map((state) => getExistingSessionLogPath(project.id, state.card.id))
        .filter(
          (sessionLogPath): sessionLogPath is string =>
            sessionLogPath !== undefined,
        ),
    });

    throw reconciliationError;
  }

  for (const state of states) {
    if (signal?.aborted) {
      return null;
    }

    if (isTerminalReviewState(state)) {
      const cardLog = logger.child({
        projectId: project.id,
        cardId: state.card.id,
      });

      if (isMergedPullRequest(state.pullRequest)) {
        await completeMergedReviewCard(
          trello,
          git,
          project,
          state.card,
          state.branch,
          state.pullRequest,
          cardLog,
          emailNotifier,
          signal,
        );
      } else if (state.pullRequest.state === "CLOSED") {
        await failClosedReviewCard(
          trello,
          project,
          state.card,
          state.pullRequest,
          cardLog,
          emailNotifier,
          signal,
        );
      }

      if (signal?.aborted) {
        return null;
      }
    }
  }

  const state = activeStates[0];

  if (state === undefined) {
    return null;
  }

  const cardLog = logger.child({
    projectId: project.id,
    cardId: state.card.id,
  });

  if (state.changesRequested !== undefined) {
    if (options.moveRequestedChanges !== false) {
      if (signal?.aborted) {
        return null;
      }

      try {
        await trello.moveCard(state.card.id, project.trello.workingListId);
      } catch (error) {
        const message = getErrorMessage(error);

        cardLog.error(
          `Failed to move card "${state.card.name}" to Working for requested changes: ${message}`,
        );

        const reconciliationError = new WorkflowError(
          "Workflow",
          `Could not move Human Review card to Working for requested changes: ${message}`,
          { cause: error },
        );

        annotateCardFailure(reconciliationError, project.id, state.card.id);
        throw reconciliationError;
      }

      if (signal?.aborted) {
        return null;
      }

      cardLog.event("Card with requested changes moved to Working");
    } else {
      cardLog.event(
        "Card with requested changes remains in Human Review while another workflow card is active",
      );
    }

    return state.changesRequested;
  }

  if (signal?.aborted) {
    return null;
  }

  return {
    card: state.card,
    active: true,
  };
}

function isTerminalReviewState(state: ReviewCardState): boolean {
  return (
    isMergedPullRequest(state.pullRequest) ||
    state.pullRequest.state === "CLOSED"
  );
}

function isMergedPullRequest(pullRequest: PullRequestState): boolean {
  return pullRequest.mergedAt !== null || pullRequest.state === "MERGED";
}

async function inspectReviewCard(
  github: GitHubClient,
  project: ProjectConfig,
  card: TrelloCard,
  signal?: AbortSignal,
): Promise<ReviewCardState | null> {
  const branch = `agent/${card.id}`;
  const options = {
    cwd: project.repository.path,
    repository: project.repository.github,
    headBranch: branch,
  };

  let pullRequest;

  try {
    pullRequest = await github.findPullRequestState(options);

    if (signal?.aborted) {
      return null;
    }
  } catch (error) {
    throw reviewLookupError(project, card, "pull request state", error);
  }

  if (pullRequest === null) {
    return null;
  }

  if (isMergedPullRequest(pullRequest) || pullRequest.state === "CLOSED") {
    return { card, branch, pullRequest };
  }

  let changesRequestedPullRequest;

  try {
    changesRequestedPullRequest =
      await github.findChangesRequestedPullRequest(options);

    if (signal?.aborted) {
      return null;
    }
  } catch (error) {
    throw reviewLookupError(project, card, "requested changes", error);
  }

  return {
    card,
    branch,
    pullRequest,
    ...(changesRequestedPullRequest === null
      ? {}
      : {
          changesRequested: {
            card,
            pullRequestUrl: changesRequestedPullRequest.url,
            feedback: changesRequestedPullRequest.feedback,
          },
        }),
  };
}

function reviewLookupError(
  project: ProjectConfig,
  card: TrelloCard,
  subject: string,
  error: unknown,
): WorkflowError {
  const message = getErrorMessage(error);

  const reconciliationError = new WorkflowError(
    "Git/GitHub",
    `Could not reconcile Human Review card "${card.name}" while checking ${subject}: ${message}`,
    { cause: error },
  );

  annotateCardFailure(reconciliationError, project.id, card.id);
  return reconciliationError;
}

async function completeMergedReviewCard(
  trello: TrelloClient,
  git: GitClient,
  project: ProjectConfig,
  card: TrelloCard,
  branch: string,
  pullRequest: PullRequestState,
  cardLog: ReturnType<typeof logger.child>,
  emailNotifier?: EmailNotifier,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return;
  }

  cardLog.event(
    `Human Review card has merged pull request: ${pullRequest.url}`,
  );

  try {
    const remoteBranchExists = await git.remoteBranchExists(
      project.repository.path,
      "origin",
      branch,
    );

    if (signal?.aborted) {
      return;
    }

    if (remoteBranchExists) {
      if (signal?.aborted) {
        return;
      }

      cardLog.info(`Deleting merged remote branch ${branch}...`);
      await git.deleteRemoteBranch(project.repository.path, "origin", branch);

      if (signal?.aborted) {
        return;
      }

      cardLog.info("Merged remote branch deleted");
    }
  } catch (error) {
    const message = getErrorMessage(error);
    cardLog.error(
      `Failed to clean up merged remote branch ${branch}: ${message}`,
    );

    const reconciliationError = new WorkflowError(
      "Git/GitHub",
      `Could not clean up merged pull request branch: ${message}`,
      { cause: error },
    );

    annotateCardFailure(reconciliationError, project.id, card.id);
    throw reconciliationError;
  }

  if (signal?.aborted) {
    return;
  }

  try {
    await trello.moveCard(card.id, project.trello.doneListId, {
      dueComplete: true,
    });

    cardLog.event("Merged card moved to Done");
  } catch (error) {
    const message = getErrorMessage(error);
    cardLog.error(
      `Failed to move merged card "${card.name}" to Done: ${message}`,
    );

    const reconciliationError = new WorkflowError(
      "Workflow",
      `Could not complete merged Human Review card: ${message}`,
      { cause: error },
    );

    annotateCardFailure(reconciliationError, project.id, card.id);
    throw reconciliationError;
  }

  if (signal?.aborted) {
    return;
  }

  await notifyCompletion(
    emailNotifier,
    {
      project,
      card,
      pullRequestUrl: pullRequest.url,
    },
    cardLog,
  );

  if (signal?.aborted) {
    return;
  }

  try {
    removeSessionLog(project.id, card.id);
    cardLog.info("OpenCode session log removed");
  } catch (error) {
    cardLog.warn(
      `Failed to remove OpenCode session log: ${getErrorMessage(error)}`,
    );
  }
}

async function failClosedReviewCard(
  trello: TrelloClient,
  project: ProjectConfig,
  card: TrelloCard,
  pullRequest: PullRequestState,
  cardLog: ReturnType<typeof logger.child>,
  emailNotifier?: EmailNotifier,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return;
  }

  cardLog.event(
    `Human Review card has closed pull request: ${pullRequest.url}`,
  );

  if (signal?.aborted) {
    return;
  }

  try {
    await trello.moveCard(card.id, project.trello.failedListId);
    cardLog.event("Card with closed pull request moved to Failed");
  } catch (error) {
    const message = getErrorMessage(error);
    cardLog.error(`Failed to move card "${card.name}" to Failed: ${message}`);

    const reconciliationError = new WorkflowError(
      "Workflow",
      `Could not move closed Human Review card to Failed: ${message}`,
      { cause: error },
    );

    annotateCardFailure(reconciliationError, project.id, card.id);
    throw reconciliationError;
  }

  if (signal?.aborted) {
    return;
  }

  await notifyFailed(
    emailNotifier,
    {
      project,
      card,
      category: "Workflow",
      reason: `Pull request ${pullRequest.url} was closed without being merged.`,
    },
    cardLog,
  );

  if (signal?.aborted) {
    return;
  }

  try {
    await trello.addComment(
      card.id,
      [
        "Pull request was closed without being merged.",
        "",
        `Pull request: ${pullRequest.url}`,
      ].join("\n"),
    );
  } catch (error) {
    cardLog.error(
      `Failed to add closed pull request comment to "${card.name}": ${getErrorMessage(error)}`,
    );
  }
}
