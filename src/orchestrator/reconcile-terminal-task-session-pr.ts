import path from "node:path";

import type { ProjectConfig } from "../config/config.js";
import { cleanupWorktree } from "../git/cleanup-worktree.js";
import type { GitClient } from "../git/git-client.js";
import type { PullRequestState } from "../github/github-client.js";
import { logger, type Logger } from "../logging/logger.js";
import { getSessionLogPath, removeSessionLog } from "../logging/session-log.js";
import {
  notifyCompletion,
  type EmailNotifier,
} from "../notifications/email-notifier.js";
import { type TrelloCard, type TrelloClient } from "../trello/trello-client.js";

import { annotateCardFailure, annotateFailure } from "./failure-diagnostic.js";
import { trelloReconciliationError } from "./trello-reconciliation-error.js";
import { WorkflowError } from "./workflow-error.js";
import {
  clearPreparedConflict,
  type PreparedConflictHandoff,
} from "./prepared-conflict-state.js";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingBranchDeletionError(error: unknown): boolean {
  const text = message(error).toLowerCase();
  return (
    text.includes("remote ref does not exist") ||
    text.includes("remote branch not found") ||
    text.includes("could not find remote ref")
  );
}

function clearTerminalConflict(
  project: ProjectConfig,
  card: TrelloCard,
  handoff: PreparedConflictHandoff | undefined,
  cardLog: Logger,
): void {
  if (handoff === undefined) return;
  try {
    clearPreparedConflict(project, card.id);
    cardLog.info(`Cleared prepared conflict handoff for ${handoff.taskBranch}`);
  } catch (error) {
    const failure = new WorkflowError(
      "Git/GitHub",
      `Could not clear prepared conflict handoff for terminal pull request: ${message(error)}`,
      { cause: error },
    );
    annotateCardFailure(failure, project.id, card.id);
    annotateFailure(failure, {
      projectId: project.id,
      cardId: card.id,
      reconciliationOperation: "Task-session terminal PR conflict cleanup",
      reconciliationListId: project.trello.reviewListId,
    });
    throw failure;
  }
}

async function cleanupTerminalWorktree(
  git: GitClient,
  project: ProjectConfig,
  card: TrelloCard,
  cardLog: Logger,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  const worktreePath = path.join(project.repository.worktreeRoot, card.id);
  const branch = `agent/${card.id}`;
  try {
    await cleanupWorktree({
      git,
      project,
      worktreePath,
      branch,
      preserveRecoveryState: true,
      signal,
    });
    if (!signal.aborted)
      cardLog.info(
        `Terminal task worktree cleanup completed for ${worktreePath}`,
      );
  } catch (error) {
    cardLog.warn(
      `Terminal task cleanup was not completed for ${worktreePath} and ${branch}: ${message(error)}`,
    );
    throw error;
  }
}

async function removeTerminalSessionLog(
  project: ProjectConfig,
  card: TrelloCard,
  cardLog: Logger,
): Promise<void> {
  try {
    removeSessionLog(project.id, card.id);
    cardLog.info("OpenCode session log removed");
  } catch (error) {
    cardLog.warn(
      `Could not remove OpenCode session log ${getSessionLogPath(project.id, card.id)}: ${message(error)}`,
    );
  }
}

export async function completeMergedTaskSessionPullRequest(options: {
  trello: TrelloClient;
  git: GitClient;
  project: ProjectConfig;
  card: TrelloCard;
  pullRequest: PullRequestState;
  preparedConflict?: PreparedConflictHandoff;
  emailNotifier?: EmailNotifier;
  signal: AbortSignal;
}): Promise<void> {
  const { trello, git, project, card, pullRequest, signal } = options;
  const cardLog = logger.child({ projectId: project.id, cardId: card.id });
  if (signal.aborted) return;
  const branch = `agent/${card.id}`;
  const remoteBranchExists = await git.remoteBranchExists(
    project.repository.path,
    "origin",
    branch,
    project,
  );
  if (signal.aborted) return;
  if (remoteBranchExists) {
    try {
      await git.deleteRemoteBranch(
        project.repository.path,
        "origin",
        branch,
        project,
      );
    } catch (error) {
      if (!isMissingBranchDeletionError(error)) throw error;
      if (
        await git.remoteBranchExists(
          project.repository.path,
          "origin",
          branch,
          project,
        )
      ) {
        throw error;
      }
    }
  }

  clearTerminalConflict(project, card, options.preparedConflict, cardLog);
  const alreadyDone = card.idList === project.trello.doneListId;
  if (!alreadyDone) {
    try {
      await trello.moveCard(card.id, project.trello.doneListId, {
        dueComplete: true,
      });
    } catch (error) {
      throw trelloReconciliationError(
        project.id,
        card.id,
        "card move",
        error,
        `Could not move merged task card to Done: ${message(error)}`,
        { reconciliationListId: project.trello.reviewListId },
      );
    }
    await notifyCompletion(
      options.emailNotifier,
      { project, card, pullRequestUrl: pullRequest.url },
      cardLog,
    );
  }
  await removeTerminalSessionLog(project, card, cardLog);
  await cleanupTerminalWorktree(git, project, card, cardLog, signal);
}

export async function returnClosedTaskSessionPullRequestToBacklog(options: {
  trello: TrelloClient;
  git: GitClient;
  project: ProjectConfig;
  card: TrelloCard;
  pullRequest: PullRequestState;
  preparedConflict?: PreparedConflictHandoff;
  signal: AbortSignal;
}): Promise<void> {
  const { trello, git, project, card, pullRequest, signal } = options;
  const cardLog = logger.child({ projectId: project.id, cardId: card.id });
  if (signal.aborted) return;
  clearTerminalConflict(project, card, options.preparedConflict, cardLog);
  const alreadyBacklog = card.idList === project.trello.backlogListId;
  if (!alreadyBacklog) {
    try {
      await trello.moveCard(card.id, project.trello.backlogListId);
    } catch (error) {
      throw trelloReconciliationError(
        project.id,
        card.id,
        "card move",
        error,
        `Could not move closed task card to Backlog: ${message(error)}`,
        { reconciliationListId: project.trello.reviewListId },
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
      cardLog.error(`Could not add closed PR note: ${message(error)}`);
    }
  }
  await cleanupTerminalWorktree(git, project, card, cardLog, signal);
}
