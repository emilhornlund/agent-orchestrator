import path from "node:path";

import type { ProjectConfig } from "../config/config.js";
import { cleanupWorktree } from "../git/cleanup-worktree.js";
import { getExistingWorktree } from "../git/prepare-worktree.js";
import type { GitClient } from "../git/git-client.js";
import type {
  GitHubClient,
  PullRequestState,
} from "../github/github-client.js";
import { logger } from "../logging/logger.js";
import {
  isRetryableTrelloError,
  type TrelloCard,
  type TrelloClient,
} from "../trello/trello-client.js";
import {
  notifyHumanReview,
  type EmailNotifier,
} from "../notifications/email-notifier.js";

import {
  completeAutoMergedCard,
  mergePullRequestForAutoMerge,
} from "./auto-merge.js";
import { correctCardToBacklog } from "./correct-card-state.js";
import {
  annotateCardFailure,
  annotateFailure,
  getExistingSessionLogPath,
} from "./failure-diagnostic.js";
import { githubReconciliationError } from "./github-reconciliation-error.js";
import type { ReviewChangeRequest } from "./reconcile-review-cards.js";
import { trelloReconciliationError } from "./trello-reconciliation-error.js";
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

function isMergedPullRequest(pullRequest: PullRequestState): boolean {
  return pullRequest.mergedAt !== null || pullRequest.state === "MERGED";
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

  if (project.autoMerge) {
    let pullRequestState;

    try {
      pullRequestState = await github.findPullRequestState({
        cwd: project.repository.path,
        repository: project.repository.github,
        headBranch: branch,
        project,
      });

      if (signal?.aborted) {
        return false;
      }
    } catch (error) {
      throw githubReconciliationError(
        project.id,
        card.id,
        "pull request state",
        error,
        `Could not reconcile claimed Working card while checking pull request state: ${getErrorMessage(error)}`,
        { reconciliationListId: project.trello.workingListId },
      );
    }

    if (pullRequestState !== null && isMergedPullRequest(pullRequestState)) {
      cardLog.event(
        `Claimed card already has merged pull request: ${pullRequestState.url}`,
      );

      await completeAutoMergedCard({
        trello,
        project,
        card,
        pullRequestUrl: pullRequestState.url,
        commitSha: "Not available during reconciliation",
        reviewResult: "Not run during reconciliation",
        remediationResult: "Not run during reconciliation",
        cardLog,
        ...(emailNotifier === undefined ? {} : { emailNotifier }),
        ...(signal === undefined ? {} : { signal }),
      });

      if (signal?.aborted) {
        return true;
      }

      await cleanupReconciledWorktree(git, project, card, cardLog, signal);
      return true;
    }
  }

  let pullRequest;

  try {
    pullRequest = await github.findPullRequest({
      cwd: project.repository.path,
      repository: project.repository.github,
      headBranch: branch,
      project,
    });

    if (signal?.aborted) {
      return false;
    }
  } catch (error) {
    throw githubReconciliationError(
      project.id,
      card.id,
      "pull request",
      error,
      `Could not reconcile claimed Working card: ${getErrorMessage(error)}`,
      { reconciliationListId: project.trello.workingListId },
    );
  }

  if (!pullRequest) {
    return false;
  }

  let changesRequestedPullRequest;

  if (project.autoMerge) {
    try {
      changesRequestedPullRequest =
        await github.findChangesRequestedPullRequest({
          cwd: project.repository.path,
          repository: project.repository.github,
          headBranch: branch,
          project,
        });

      if (signal?.aborted) {
        return false;
      }
    } catch (error) {
      throw githubReconciliationError(
        project.id,
        card.id,
        "requested changes",
        error,
        `Could not check requested changes for claimed Working card: ${getErrorMessage(error)}`,
        { reconciliationListId: project.trello.workingListId },
      );
    }
  }

  if (project.autoMerge) {
    if (changesRequestedPullRequest === null) {
      let commitSha;

      try {
        commitSha = await git.getHeadSha(
          path.join(project.repository.worktreeRoot, card.id),
        );
      } catch (error) {
        const message = getErrorMessage(error);
        const reconciliationError = new WorkflowError(
          "Git/GitHub",
          `Could not reconcile claimed Working card while checking its published commit: ${message}`,
          { cause: error },
        );

        annotateCardFailure(reconciliationError, project.id, card.id);
        throw reconciliationError;
      }

      cardLog.event(
        `Auto-merging claimed card pull request: ${pullRequest.url}`,
      );

      await mergePullRequestForAutoMerge(
        github,
        project,
        card,
        pullRequest.url,
        commitSha,
        path.join(project.repository.worktreeRoot, card.id),
        signal,
      );

      await completeAutoMergedCard({
        trello,
        project,
        card,
        pullRequestUrl: pullRequest.url,
        commitSha,
        reviewResult: "Not run during reconciliation",
        remediationResult: "Not run during reconciliation",
        cardLog,
        ...(emailNotifier === undefined ? {} : { emailNotifier }),
        ...(signal === undefined ? {} : { signal }),
      });

      if (signal?.aborted) {
        return true;
      }

      await cleanupReconciledWorktree(git, project, card, cardLog, signal);
      return true;
    }

    cardLog.event("Claimed card has actionable requested changes");
  }

  cardLog.event(`Claimed card already has pull request: ${pullRequest.url}`);
  cardLog.event("Moving claimed card directly to Human Review...");

  if (signal?.aborted) {
    return false;
  }

  try {
    await trello.moveCard(card.id, project.trello.reviewListId);
  } catch (error) {
    throw trelloReconciliationError(
      project.id,
      card.id,
      "card move",
      error,
      `Could not move claimed Working card to Human Review: ${getErrorMessage(error)}`,
      { reconciliationListId: project.trello.workingListId },
    );
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

  await cleanupReconciledWorktree(git, project, card, cardLog, signal);

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
    throw trelloReconciliationError(
      project.id,
      undefined,
      "card lookup",
      error,
      `Could not retrieve Working cards: ${getErrorMessage(error)}`,
      { reconciliationListId: project.trello.workingListId },
    );
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
      if (!isRetryableTrelloError(error)) {
        throw error;
      }

      throw trelloReconciliationError(
        project.id,
        card.id,
        "transition history",
        error,
        `Could not read Working card transition history: ${getErrorMessage(error)}`,
        { reconciliationListId: project.trello.workingListId },
      );
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
        worktree,
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
  worktree: { path: string; branch: string },
  emailNotifier?: EmailNotifier,
  signal?: AbortSignal,
): Promise<WorkingCardRecovery | null> {
  const branch = `agent/${card.id}`;
  const cardLog = logger.child({
    projectId: project.id,
    cardId: card.id,
  });

  if (project.autoMerge && workflow === "implementation") {
    let pullRequestState;

    try {
      pullRequestState = await github.findPullRequestState({
        cwd: project.repository.path,
        repository: project.repository.github,
        headBranch: branch,
        project,
      });

      if (signal?.aborted) {
        return null;
      }
    } catch (error) {
      throw githubReconciliationError(
        project.id,
        card.id,
        "pull request state",
        error,
        `Could not reconcile Working card while checking pull request state: ${getErrorMessage(error)}`,
      );
    }

    if (pullRequestState !== null && isMergedPullRequest(pullRequestState)) {
      cardLog.event(
        `Working card already has merged pull request: ${pullRequestState.url}`,
      );

      await completeAutoMergedCard({
        trello,
        project,
        card,
        pullRequestUrl: pullRequestState.url,
        commitSha: "Not available during reconciliation",
        reviewResult: "Not run during reconciliation",
        remediationResult: "Not run during reconciliation",
        cardLog,
        ...(emailNotifier === undefined ? {} : { emailNotifier }),
        ...(signal === undefined ? {} : { signal }),
      });

      if (signal?.aborted) {
        return null;
      }

      await cleanupReconciledWorktree(git, project, card, cardLog, signal);
      return null;
    }
  }

  let pullRequest;

  try {
    pullRequest = await github.findPullRequest({
      cwd: project.repository.path,
      repository: project.repository.github,
      headBranch: branch,
      project,
    });

    if (signal?.aborted) {
      return null;
    }
  } catch (error) {
    throw githubReconciliationError(
      project.id,
      card.id,
      "pull request",
      error,
      `Could not reconcile Working card: ${getErrorMessage(error)}`,
    );
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
      project,
    });

    if (signal?.aborted) {
      return null;
    }
  } catch (error) {
    throw githubReconciliationError(
      project.id,
      card.id,
      "requested changes",
      error,
      `Could not check requested changes for Working card: ${getErrorMessage(error)}`,
    );
  }

  if (changesRequestedPullRequest) {
    cardLog.event("Working card has actionable requested changes");

    return {
      card,
      pullRequestUrl: changesRequestedPullRequest.url,
      feedback: changesRequestedPullRequest.feedback,
    };
  }

  if (project.autoMerge) {
    cardLog.event(`Auto-merging reconciled pull request: ${pullRequest.url}`);

    let commitSha: string;

    try {
      commitSha = await git.getHeadSha(worktree.path);
    } catch (error) {
      const message = getErrorMessage(error);
      const reconciliationError = new WorkflowError(
        "Git/GitHub",
        `Could not reconcile Working card while checking its published commit: ${message}`,
        { cause: error },
      );

      annotateCardFailure(reconciliationError, project.id, card.id);
      throw reconciliationError;
    }

    await mergePullRequestForAutoMerge(
      github,
      project,
      card,
      pullRequest.url,
      commitSha,
      worktree.path,
      signal,
    );

    await completeAutoMergedCard({
      trello,
      project,
      card,
      pullRequestUrl: pullRequest.url,
      commitSha,
      reviewResult: "Not run during reconciliation",
      remediationResult: "Not run during reconciliation",
      cardLog,
      ...(emailNotifier === undefined ? {} : { emailNotifier }),
      ...(signal === undefined ? {} : { signal }),
    });

    if (signal?.aborted) {
      return null;
    }

    await cleanupReconciledWorktree(git, project, card, cardLog, signal);
    return null;
  }

  cardLog.event("Moving reconciled card to Human Review...");

  if (signal?.aborted) {
    return null;
  }

  try {
    await trello.moveCard(card.id, project.trello.reviewListId);
  } catch (error) {
    const message = getErrorMessage(error);

    const reconciliationError = trelloReconciliationError(
      project.id,
      card.id,
      "card move",
      error,
      `Could not move Working card to Human Review: ${message}`,
      { reconciliationListId: project.trello.workingListId },
    );

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
      preserveRecoveryState: true,
      ...(signal === undefined ? {} : { signal }),
    });

    if (signal?.aborted) {
      return null;
    }

    cardLog.info("Reconciled card local worktree cleaned up");
  } catch (error) {
    cardLog.warn(
      `Housekeeping cleanup warning for project "${project.id}", card "${card.id}": could not remove the reconciled worktree and local branch ${worktreePathForLog(project, card.id)} and agent/${card.id}: ${getErrorMessage(error)}`,
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
      project,
    });

    if (signal?.aborted) {
      return null;
    }
  } catch (error) {
    throw githubReconciliationError(
      project.id,
      card.id,
      "pull request",
      error,
      `Could not reconcile Working card moved from Human Review: ${getErrorMessage(error)}`,
      { reconciliationListId: project.trello.workingListId },
    );
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
      project,
    });

    if (signal?.aborted) {
      return null;
    }
  } catch (error) {
    throw githubReconciliationError(
      project.id,
      card.id,
      "requested changes",
      error,
      `Could not check requested changes for Working card moved from Human Review: ${getErrorMessage(error)}`,
      { reconciliationListId: project.trello.workingListId },
    );
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

async function cleanupReconciledWorktree(
  git: GitClient,
  project: ProjectConfig,
  card: TrelloCard,
  cardLog: ReturnType<typeof logger.child>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return;
  }

  try {
    await cleanupWorktree({
      git,
      project,
      worktreePath: worktreePathForLog(project, card.id),
      branch: `agent/${card.id}`,
      preserveRecoveryState: true,
      ...(signal === undefined ? {} : { signal }),
    });

    if (signal?.aborted) {
      return;
    }

    cardLog.info("Reconciled completed card local worktree cleaned up");
  } catch (error) {
    cardLog.warn(
      `Housekeeping cleanup warning for project "${project.id}", card "${card.id}": could not remove the reconciled worktree and local branch ${worktreePathForLog(project, card.id)} and agent/${card.id}: ${getErrorMessage(error)}`,
    );
  }
}

export function isImplementationWorkingCard(
  recovery: WorkingCardRecovery,
): recovery is WorkingCard {
  return !isReviewChangeRequest(recovery);
}
