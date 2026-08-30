import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient, PullRequest } from "../github/github-client.js";
import { logger } from "../logging/logger.js";
import { removeSessionLog } from "../logging/session-log.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";

import { correctCardToBacklog } from "./correct-card-state.js";
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
  mergedPullRequest?: PullRequest;
  closedPullRequest?: PullRequest;
  changesRequested?: ReviewChangeRequest;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function reconcileReviewCards(
  trello: TrelloClient,
  git: GitClient,
  github: GitHubClient,
  project: ProjectConfig,
): Promise<ReviewChangeRequest | ActiveReviewCard | null> {
  const projectLog = logger.child({
    projectId: project.id,
  });

  const cards = await trello.getCards(project.trello.reviewListId);

  if (cards.length === 0) {
    return null;
  }

  projectLog.info(`Reconciling ${cards.length} card(s) in Human Review...`);

  const states: ReviewCardState[] = [];

  for (const card of cards) {
    const state = await inspectReviewCard(github, project, card);

    if (state === null) {
      await correctCardToBacklog(
        trello,
        project,
        card,
        `Human Review card has no expected pull request for agent/${card.id}`,
      );

      continue;
    }

    states.push(state);
  }

  if (states.length > 1) {
    const cardIds = states.map((state) => state.card.id).join(", ");

    projectLog.error(
      `Found multiple active cards in Human Review: ${cardIds}; blocking the project until the ambiguous state is resolved`,
    );

    throw new WorkflowError(
      "Workflow",
      `Multiple active cards are in Human Review: ${cardIds}`,
    );
  }

  const state = states[0];

  if (state === undefined) {
    return null;
  }

  const cardLog = logger.child({
    projectId: project.id,
    cardId: state.card.id,
  });

  if (state.mergedPullRequest !== undefined) {
    await completeMergedReviewCard(
      trello,
      git,
      project,
      state.card,
      state.branch,
      state.mergedPullRequest,
      cardLog,
    );

    return null;
  }

  if (state.closedPullRequest !== undefined) {
    await failClosedReviewCard(
      trello,
      project,
      state.card,
      state.closedPullRequest,
      cardLog,
    );

    return null;
  }

  if (state.changesRequested !== undefined) {
    try {
      await trello.moveCard(state.card.id, project.trello.workingListId);
    } catch (error) {
      const message = getErrorMessage(error);

      cardLog.error(
        `Failed to move card "${state.card.name}" to Working for requested changes: ${message}`,
      );

      throw new WorkflowError(
        "Workflow",
        `Could not move Human Review card to Working for requested changes: ${message}`,
        { cause: error },
      );
    }

    cardLog.event("Card with requested changes moved to Working");

    return state.changesRequested;
  }

  cardLog.event("Human Review card remains active");

  return {
    card: state.card,
    active: true,
  };
}

async function inspectReviewCard(
  github: GitHubClient,
  project: ProjectConfig,
  card: TrelloCard,
): Promise<ReviewCardState | null> {
  const branch = `agent/${card.id}`;
  const options = {
    cwd: project.repository.path,
    repository: project.repository.github,
    headBranch: branch,
  };

  let mergedPullRequest;

  try {
    mergedPullRequest = await github.findMergedPullRequest(options);
  } catch (error) {
    throw reviewLookupError(card, "merged pull request", error);
  }

  if (mergedPullRequest !== null) {
    return { card, branch, mergedPullRequest };
  }

  let closedPullRequest;

  try {
    closedPullRequest = await github.findClosedPullRequest(options);
  } catch (error) {
    throw reviewLookupError(card, "closed pull request", error);
  }

  if (closedPullRequest !== null) {
    return { card, branch, closedPullRequest };
  }

  let openPullRequest;

  try {
    openPullRequest = await github.findPullRequest(options);
  } catch (error) {
    throw reviewLookupError(card, "expected open pull request", error);
  }

  if (openPullRequest === null) {
    return null;
  }

  let changesRequestedPullRequest;

  try {
    changesRequestedPullRequest =
      await github.findChangesRequestedPullRequest(options);
  } catch (error) {
    throw reviewLookupError(card, "requested changes", error);
  }

  return {
    card,
    branch,
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
  card: TrelloCard,
  subject: string,
  error: unknown,
): WorkflowError {
  const message = getErrorMessage(error);

  return new WorkflowError(
    "Git/GitHub",
    `Could not reconcile Human Review card "${card.name}" while checking ${subject}: ${message}`,
    { cause: error },
  );
}

async function completeMergedReviewCard(
  trello: TrelloClient,
  git: GitClient,
  project: ProjectConfig,
  card: TrelloCard,
  branch: string,
  pullRequest: PullRequest,
  cardLog: ReturnType<typeof logger.child>,
): Promise<void> {
  cardLog.event(
    `Human Review card has merged pull request: ${pullRequest.url}`,
  );

  try {
    const remoteBranchExists = await git.remoteBranchExists(
      project.repository.path,
      "origin",
      branch,
    );

    if (remoteBranchExists) {
      cardLog.info(`Deleting merged remote branch ${branch}...`);
      await git.deleteRemoteBranch(project.repository.path, "origin", branch);
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
  pullRequest: PullRequest,
  cardLog: ReturnType<typeof logger.child>,
): Promise<void> {
  cardLog.event(
    `Human Review card has closed pull request: ${pullRequest.url}`,
  );

  try {
    await trello.moveCard(card.id, project.trello.failedListId);
    cardLog.event("Card with closed pull request moved to Failed");
  } catch (error) {
    const message = getErrorMessage(error);
    cardLog.error(`Failed to move card "${card.name}" to Failed: ${message}`);

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
        `Pull request: ${pullRequest.url}`,
      ].join("\n"),
    );
  } catch (error) {
    cardLog.error(
      `Failed to add closed pull request comment to "${card.name}": ${getErrorMessage(error)}`,
    );
  }
}
