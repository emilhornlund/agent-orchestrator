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
  type EmailNotifier,
} from "../notifications/email-notifier.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";
import type { CommandRunner } from "../process/command-runner.js";

import { correctCardToBacklog } from "./correct-card-state.js";
import {
  annotateCardFailure,
  annotateFailure,
  getExistingSessionLogPath,
} from "./failure-diagnostic.js";
import { githubReconciliationError } from "./github-reconciliation-error.js";
import { trelloReconciliationError } from "./trello-reconciliation-error.js";
import { WorkflowError } from "./workflow-error.js";
import { maintainReviewPullRequest } from "./maintain-review-pull-request.js";
import {
  clearPreparedConflict,
  readPreparedConflict,
  type PreparedConflictHandoff,
} from "./prepared-conflict-state.js";

export interface ReviewChangeRequest {
  card: TrelloCard;
  pullRequestUrl: string;
  feedback: string;
  maintenanceState?: PullRequestMaintenanceState;
}

export type PullRequestMaintenanceState =
  "up-to-date" | "behind" | "conflicted" | "prepared-conflict";

export interface ActiveReviewCard {
  card: TrelloCard;
  active: true;
  maintenanceState: PullRequestMaintenanceState;
  preparedConflict?: PreparedConflictHandoff;
}

interface ReviewCardState {
  card: TrelloCard;
  branch: string;
  pullRequest: PullRequestState;
  maintenanceState?: PullRequestMaintenanceState;
  changesRequested?: ReviewChangeRequest;
  preparedConflict?: PreparedConflictHandoff;
}

export interface ReconcileReviewCardsOptions {
  moveRequestedChanges?: boolean;
  maintenance?: {
    commands: CommandRunner;
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingRemoteBranchDeletionError(error: unknown): boolean {
  return getErrorMessage(error)
    .toLowerCase()
    .includes("remote ref does not exist");
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
    throw trelloReconciliationError(
      project.id,
      undefined,
      "card lookup",
      error,
      `Could not retrieve Human Review cards: ${getErrorMessage(error)}`,
    );
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

  const preparedConflictState = activeStates.find(
    (state) => state.preparedConflict !== undefined,
  );

  if (preparedConflictState !== undefined) {
    const preparedConflict = preparedConflictState.preparedConflict;

    if (preparedConflict === undefined) {
      throw new WorkflowError(
        "Workflow",
        "Prepared conflict state was not complete during reconciliation",
      );
    }

    return {
      card: preparedConflictState.card,
      active: true,
      maintenanceState: "prepared-conflict",
      preparedConflict,
    };
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
          state.preparedConflict,
          cardLog,
          emailNotifier,
          signal,
        );
      } else if (state.pullRequest.state === "CLOSED") {
        await returnClosedReviewCardToBacklog(
          trello,
          project,
          state.card,
          state.pullRequest,
          state.preparedConflict,
          cardLog,
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

        const reconciliationError = trelloReconciliationError(
          project.id,
          state.card.id,
          "card move",
          error,
          `Could not move Human Review card to Working for requested changes: ${message}`,
        );

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

  if (state.preparedConflict !== undefined) {
    return {
      card: state.card,
      active: true,
      maintenanceState: "prepared-conflict",
      preparedConflict: state.preparedConflict,
    };
  }

  let maintenanceState = state.maintenanceState!;

  if (options.maintenance !== undefined && maintenanceState === "behind") {
    const maintenanceResult = await maintainReviewPullRequest({
      git,
      github,
      commands: options.maintenance.commands,
      project,
      card: state.card,
      pullRequest: state.pullRequest,
      cardLog,
      ...(signal === undefined ? {} : { signal }),
    });

    if (signal?.aborted) {
      return null;
    }

    if (maintenanceResult === "rebased") {
      maintenanceState = "up-to-date";
    }

    if (maintenanceResult === "prepared-conflict") {
      const preparedConflict = readPreparedConflict(project, state.card.id);

      if (preparedConflict === null) {
        throw new WorkflowError(
          "Git/GitHub",
          "Prepared conflict state disappeared before it could be exposed",
        );
      }

      return {
        card: state.card,
        active: true,
        maintenanceState: "prepared-conflict",
        preparedConflict,
      };
    }
  }

  return {
    card: state.card,
    active: true,
    maintenanceState,
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

function isOwnedPullRequest(
  pullRequest: PullRequestState,
  project: ProjectConfig,
  branch: string,
): boolean {
  return (
    pullRequest.baseRefName === project.repository.defaultBranch &&
    pullRequest.headRefName === branch &&
    pullRequest.headRepositoryNameWithOwner === project.repository.github
  );
}

async function inspectReviewCard(
  github: GitHubClient,
  project: ProjectConfig,
  card: TrelloCard,
  signal?: AbortSignal,
): Promise<ReviewCardState | null> {
  const branch = `agent/${card.id}`;
  let preparedConflict: PreparedConflictHandoff | null;

  try {
    preparedConflict = readPreparedConflict(project, card.id);
  } catch (error) {
    throw reviewLookupError(project, card, "prepared conflict handoff", error);
  }

  const options = {
    cwd: project.repository.path,
    repository: project.repository.github,
    headBranch: branch,
    baseBranch: project.repository.defaultBranch,
    project,
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
    if (preparedConflict !== null) {
      throw reviewLookupError(
        project,
        card,
        "prepared conflict handoff",
        new Error("Prepared conflict has no authoritative pull request"),
      );
    }

    return null;
  }

  if (preparedConflict !== null) {
    if (!isOwnedPullRequest(pullRequest, project, branch)) {
      throw reviewLookupError(
        project,
        card,
        "prepared conflict handoff",
        new Error(
          "Prepared conflict handoff no longer matches the authoritative pull request",
        ),
      );
    }

    if (pullRequest.state === "OPEN" && !isMergedPullRequest(pullRequest)) {
      return {
        card,
        branch,
        pullRequest,
        maintenanceState: "prepared-conflict",
        preparedConflict,
      };
    }
  }

  if (
    pullRequest.headRefName !== undefined &&
    pullRequest.headRefName !== branch
  ) {
    return null;
  }

  if (pullRequest.headRepositoryNameWithOwner !== project.repository.github) {
    return null;
  }

  if (isMergedPullRequest(pullRequest) || pullRequest.state === "CLOSED") {
    return {
      card,
      branch,
      pullRequest,
      ...(preparedConflict === null ? {} : { preparedConflict }),
    };
  }

  let maintenanceState: PullRequestMaintenanceState;

  try {
    maintenanceState = classifyMaintenanceState(
      pullRequest,
      branch,
      project.repository.defaultBranch,
    );
  } catch (error) {
    throw reviewLookupError(project, card, "maintenance state", error);
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
    maintenanceState,
    ...(changesRequestedPullRequest === null
      ? {}
      : {
          changesRequested: {
            card,
            pullRequestUrl: changesRequestedPullRequest.url,
            feedback: changesRequestedPullRequest.feedback,
            maintenanceState,
          },
        }),
  };
}

function reviewLookupError(
  project: ProjectConfig,
  card: TrelloCard,
  subject:
    | "pull request state"
    | "requested changes"
    | "maintenance state"
    | "prepared conflict handoff",
  error: unknown,
): WorkflowError {
  return githubReconciliationError(
    project.id,
    card.id,
    subject,
    error,
    `Could not reconcile Human Review card "${card.name}" while checking ${subject}: ${getErrorMessage(error)}`,
  );
}

function classifyMaintenanceState(
  pullRequest: PullRequestState,
  expectedHeadBranch: string,
  expectedBaseBranch: string,
): PullRequestMaintenanceState {
  const { baseRefName, headRefName, mergeable, mergeStateStatus } = pullRequest;

  if (
    baseRefName !== expectedBaseBranch ||
    headRefName !== expectedHeadBranch ||
    mergeable === undefined ||
    mergeStateStatus === undefined
  ) {
    throw new Error(
      "GitHub returned incomplete or mismatched pull request maintenance state",
    );
  }

  if (mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY") {
    return "conflicted";
  }

  if (mergeable === "UNKNOWN" || mergeStateStatus === "UNKNOWN") {
    throw new Error(
      "GitHub returned an ambiguous pull request maintenance state",
    );
  }

  if (mergeStateStatus === "BEHIND") {
    return "behind";
  }

  if (
    mergeStateStatus === "CLEAN" ||
    mergeStateStatus === "BLOCKED" ||
    mergeStateStatus === "HAS_HOOKS" ||
    mergeStateStatus === "UNSTABLE"
  ) {
    return "up-to-date";
  }

  throw new Error(
    `GitHub returned unsupported pull request merge state ${mergeStateStatus}`,
  );
}

async function completeMergedReviewCard(
  trello: TrelloClient,
  git: GitClient,
  project: ProjectConfig,
  card: TrelloCard,
  branch: string,
  pullRequest: PullRequestState,
  preparedConflict: PreparedConflictHandoff | undefined,
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

  if (preparedConflict !== undefined) {
    clearPreparedConflictForTerminalCard(
      project,
      card,
      preparedConflict,
      cardLog,
    );
  }

  try {
    const remoteBranchExists = await git.remoteBranchExists(
      project.repository.path,
      "origin",
      branch,
      project,
    );

    if (signal?.aborted) {
      return;
    }

    if (remoteBranchExists) {
      if (signal?.aborted) {
        return;
      }

      cardLog.info(`Deleting merged remote branch ${branch}...`);

      try {
        await git.deleteRemoteBranch(
          project.repository.path,
          "origin",
          branch,
          project,
        );
      } catch (error) {
        if (!isMissingRemoteBranchDeletionError(error)) {
          throw error;
        }

        // A remote branch can disappear after the existence check but before deletion.
        let branchStillExists: boolean;

        try {
          branchStillExists = await git.remoteBranchExists(
            project.repository.path,
            "origin",
            branch,
            project,
          );
        } catch {
          throw error;
        }

        if (branchStillExists) {
          throw error;
        }

        cardLog.info("Merged remote branch was already absent");
      }

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

    const reconciliationError = trelloReconciliationError(
      project.id,
      card.id,
      "card move",
      error,
      `Could not complete merged Human Review card: ${message}`,
    );

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

async function returnClosedReviewCardToBacklog(
  trello: TrelloClient,
  project: ProjectConfig,
  card: TrelloCard,
  pullRequest: PullRequestState,
  preparedConflict: PreparedConflictHandoff | undefined,
  cardLog: ReturnType<typeof logger.child>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return;
  }

  cardLog.event(
    `Human Review card has closed pull request: ${pullRequest.url}`,
  );

  if (preparedConflict !== undefined) {
    clearPreparedConflictForTerminalCard(
      project,
      card,
      preparedConflict,
      cardLog,
    );
  }

  if (signal?.aborted) {
    return;
  }

  try {
    await trello.moveCard(card.id, project.trello.backlogListId);
    cardLog.event("Card with closed pull request moved to Backlog");
  } catch (error) {
    const message = getErrorMessage(error);
    cardLog.error(`Failed to move card "${card.name}" to Backlog: ${message}`);

    const reconciliationError = trelloReconciliationError(
      project.id,
      card.id,
      "card move",
      error,
      `Could not move closed Human Review card to Backlog: ${message}`,
    );

    throw reconciliationError;
  }

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

function clearPreparedConflictForTerminalCard(
  project: ProjectConfig,
  card: TrelloCard,
  preparedConflict: PreparedConflictHandoff,
  cardLog: ReturnType<typeof logger.child>,
): void {
  try {
    clearPreparedConflict(project, card.id);
    cardLog.info(
      `Cleared prepared conflict handoff for terminal pull request ${preparedConflict.taskBranch}`,
    );
  } catch (error) {
    const reconciliationError = new WorkflowError(
      "Git/GitHub",
      `Could not clear prepared conflict handoff for terminal pull request: ${getErrorMessage(error)}`,
      { cause: error },
    );

    annotateCardFailure(reconciliationError, project.id, card.id);
    throw reconciliationError;
  }
}
