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
import {
  annotateCardFailure,
  annotateFailure,
  getExistingSessionLogPath,
} from "./failure-diagnostic.js";
import type { ReviewChangeRequest } from "./reconcile-review-cards.js";
import { getElapsedWorkflowTime } from "./workflow-duration.js";
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
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) {
    return false;
  }

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

    if (signal?.aborted) {
      return false;
    }
  } catch (error) {
    const message = getErrorMessage(error);
    const reconciliationError = new WorkflowError(
      "Git/GitHub",
      `Could not reconcile claimed Working card: ${message}`,
      { cause: error },
    );

    annotateCardFailure(reconciliationError, project.id, card.id);
    throw reconciliationError;
  }

  if (!pullRequest) {
    return false;
  }

  cardLog.event(`Claimed card already has pull request: ${pullRequest.url}`);
  cardLog.event("Moving claimed card directly to Human Review...");

  if (signal?.aborted) {
    return false;
  }

  try {
    await trello.moveCard(card.id, project.trello.reviewListId);
  } catch (error) {
    if (error instanceof Error) {
      annotateCardFailure(error, project.id, card.id);
    }

    throw error;
  }

  if (signal?.aborted) {
    return true;
  }

  cardLog.event("Claimed card moved directly to Human Review");

  if (signal?.aborted) {
    return true;
  }

  const elapsedWorkflowTime = await getElapsedWorkflowTime(
    trello,
    project,
    card.id,
    cardLog,
  );

  if (signal?.aborted) {
    return true;
  }

  await notifyHumanReview(
    emailNotifier,
    {
      project,
      card,
      pullRequestUrl: pullRequest.url,
      commitSha: "Not available during reconciliation",
      reviewResult: "Not run during reconciliation",
      remediationResult: "Not run during reconciliation",
      ...(elapsedWorkflowTime === undefined ? {} : { elapsedWorkflowTime }),
      publicationContext:
        "An existing pull request was found during reconciliation and the claimed card was moved directly to Human Review.",
    },
    cardLog,
  );

  if (signal?.aborted) {
    return true;
  }

  const worktreePath = path.join(project.repository.worktreeRoot, card.id);

  try {
    await cleanupWorktree({
      git,
      project,
      worktreePath,
      branch,
      ...(signal === undefined ? {} : { signal }),
    });

    if (signal?.aborted) {
      return true;
    }

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
  signal?: AbortSignal,
): Promise<WorkingCardRecovery | null> {
  if (signal?.aborted) {
    return null;
  }

  const projectLog = logger.child({
    projectId: project.id,
  });

  let cards: TrelloCard[];

  try {
    cards = await trello.getCards(project.trello.workingListId);
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

  projectLog.info(`Reconciling ${cards.length} card(s) in Working...`);

  const recoverableCards: WorkingCardRecovery[] = [];

  for (const card of cards) {
    if (signal?.aborted) {
      return null;
    }

    let transition;

    try {
      transition = await trello.getLatestListTransition(
        card.id,
        project.trello.workingListId,
      );
    } catch (error) {
      if (error instanceof Error) {
        annotateCardFailure(error, project.id, card.id);
      }

      throw error;
    }

    if (signal?.aborted) {
      return null;
    }

    if (transition === null) {
      await correctCardToBacklog(
        trello,
        project,
        card,
        "Working card has no recorded transition into Working",
        signal,
      );

      if (signal?.aborted) {
        return null;
      }

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
          signal,
        );

        if (signal?.aborted) {
          return null;
        }

        continue;
      }

      let worktree;

      try {
        worktree = await getExistingWorktree(git, project, card.id);
      } catch (error) {
        if (error instanceof Error) {
          annotateCardFailure(error, project.id, card.id);
        }

        throw error;
      }

      if (signal?.aborted) {
        return null;
      }

      if (worktree === null) {
        await correctCardToBacklog(
          trello,
          project,
          card,
          `Working card has no valid ${worktreePathForLog(project, card.id)} worktree on agent/${card.id}`,
          signal,
        );

        if (signal?.aborted) {
          return null;
        }

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
        signal,
      );

      if (signal?.aborted) {
        return null;
      }

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
        signal,
      );

      if (signal?.aborted) {
        return null;
      }

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
      signal,
    );

    if (signal?.aborted) {
      return null;
    }
  }

  if (signal?.aborted) {
    return null;
  }

  if (recoverableCards.length > 1) {
    const cardIds = recoverableCards
      .map((recovery) => recovery.card.id)
      .join(", ");

    projectLog.error(
      `Found multiple active cards in Working: ${cardIds}; blocking the project until the ambiguous state is resolved`,
    );

    const reconciliationError = new WorkflowError(
      "Workflow",
      `Multiple active cards are in Working: ${cardIds}`,
    );

    annotateFailure(reconciliationError, {
      projectId: project.id,
      cardIds: recoverableCards.map((recovery) => recovery.card.id),
      sessionLogPaths: recoverableCards
        .map((recovery) =>
          getExistingSessionLogPath(project.id, recovery.card.id),
        )
        .filter(
          (sessionLogPath): sessionLogPath is string =>
            sessionLogPath !== undefined,
        ),
    });

    throw reconciliationError;
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
  signal?: AbortSignal,
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

    if (signal?.aborted) {
      return null;
    }
  } catch (error) {
    const message = getErrorMessage(error);

    const reconciliationError = new WorkflowError(
      "Git/GitHub",
      `Could not reconcile Working card: ${message}`,
      { cause: error },
    );

    annotateCardFailure(reconciliationError, project.id, card.id);
    throw reconciliationError;
  }

  if (!pullRequest) {
    cardLog.event(`Resuming ${workflow} workflow from its existing worktree`);

    return {
      card,
      workflow,
    };
  }

  if (workflow !== "implementation") {
    if (signal?.aborted) {
      return null;
    }

    await correctCardToBacklog(
      trello,
      project,
      card,
      `Refinement Working card has unexpected pull request ${pullRequest.url}`,
      signal,
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

    if (signal?.aborted) {
      return null;
    }
  } catch (error) {
    const message = getErrorMessage(error);

    const reconciliationError = new WorkflowError(
      "Git/GitHub",
      `Could not check requested changes for Working card: ${message}`,
      { cause: error },
    );

    annotateCardFailure(reconciliationError, project.id, card.id);
    throw reconciliationError;
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

  if (signal?.aborted) {
    return null;
  }

  try {
    await trello.moveCard(card.id, project.trello.reviewListId);
  } catch (error) {
    const message = getErrorMessage(error);

    const reconciliationError = new WorkflowError(
      "Workflow",
      `Could not move Working card to Human Review: ${message}`,
      { cause: error },
    );

    annotateCardFailure(reconciliationError, project.id, card.id);
    throw reconciliationError;
  }

  if (signal?.aborted) {
    return null;
  }

  cardLog.event("Reconciled card moved to Human Review");

  if (signal?.aborted) {
    return null;
  }

  const elapsedWorkflowTime = await getElapsedWorkflowTime(
    trello,
    project,
    card.id,
    cardLog,
  );

  if (signal?.aborted) {
    return null;
  }

  await notifyHumanReview(
    emailNotifier,
    {
      project,
      card,
      pullRequestUrl: pullRequest.url,
      commitSha: "Not available during reconciliation",
      reviewResult: "Not run during reconciliation",
      remediationResult: "Not run during reconciliation",
      ...(elapsedWorkflowTime === undefined ? {} : { elapsedWorkflowTime }),
      publicationContext:
        "An existing pull request was found during reconciliation and the Working card was moved to Human Review.",
    },
    cardLog,
  );

  if (signal?.aborted) {
    return null;
  }

  try {
    await cleanupWorktree({
      git,
      project,
      worktreePath: path.join(project.repository.worktreeRoot, card.id),
      branch,
      ...(signal === undefined ? {} : { signal }),
    });

    if (signal?.aborted) {
      return null;
    }

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
  signal?: AbortSignal,
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

    if (signal?.aborted) {
      return null;
    }
  } catch (error) {
    const message = getErrorMessage(error);

    const reconciliationError = new WorkflowError(
      "Git/GitHub",
      `Could not reconcile Working card moved from Human Review: ${message}`,
      { cause: error },
    );

    annotateCardFailure(reconciliationError, project.id, card.id);
    throw reconciliationError;
  }

  if (!pullRequest) {
    if (signal?.aborted) {
      return null;
    }

    await correctCardToBacklog(
      trello,
      project,
      card,
      `Working card moved from Human Review without an expected open pull request for ${branch}`,
      signal,
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

    if (signal?.aborted) {
      return null;
    }
  } catch (error) {
    const message = getErrorMessage(error);

    const reconciliationError = new WorkflowError(
      "Git/GitHub",
      `Could not check requested changes for Working card moved from Human Review: ${message}`,
      { cause: error },
    );

    annotateCardFailure(reconciliationError, project.id, card.id);
    throw reconciliationError;
  }

  if (!changesRequestedPullRequest) {
    if (signal?.aborted) {
      return null;
    }

    await correctCardToBacklog(
      trello,
      project,
      card,
      `Working card moved from Human Review without actionable requested changes on ${pullRequest.url}`,
      signal,
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
