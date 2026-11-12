import { taskResources } from "../task-session/task-resources.js";
import { assertTerminalArtifactIsolation } from "../git/terminal-artifact-isolation.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { throwIfWorkflowMutationPending } from "../task-session/workflow-mutation.js";
import { closedPrComment } from "../task-session/terminal-pr-fence.js";

import type { ProjectConfig } from "../config/config.js";
import { cleanupWorktree } from "../git/cleanup-worktree.js";
import type { GitClient } from "../git/git-client.js";
import type { PullRequestState } from "../github/github-client.js";
import { MalformedManagedPullRequestStatusError } from "../github/pull-request-status.js";
import type { GitHubClient } from "../github/github-client.js";
import { logger, type Logger } from "../logging/logger.js";
import {
  notifyCompletion,
  enqueueNotification,
  buildCompletionEmail,
  type EmailNotifier,
} from "../notifications/email-notifier.js";
import { type TrelloCard, type TrelloClient } from "../trello/trello-client.js";

import { annotateCardFailure, annotateFailure } from "./failure-diagnostic.js";
import { trelloReconciliationError } from "./trello-reconciliation-error.js";
import { WorkflowError } from "./workflow-error.js";
import { clearPreparedConflict, type PreparedConflictHandoff } from "./prepared-conflict-state.js";

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
  preservedHeadSha: string,
): Promise<void> {
  if (signal.aborted) return;
  const { path: worktreePath, branch } = taskResources(project, card.id);
  try {
    await cleanupWorktree({
      git,
      project,
      worktreePath,
      branch,
      preserveRecoveryState: true,
      preservedHeadSha,
      signal,
    });
    if (!signal.aborted)
      cardLog.info(`Terminal task worktree cleanup completed for ${worktreePath}`);
  } catch (error) {
    cardLog.warn(
      `Terminal task cleanup was not completed for ${worktreePath} and ${branch}: ${message(error)}`,
    );
    // A dispatched cleanup still needs its journal outcome reconciled. Otherwise
    // preserve known resources; future attempts use distinct names, not this path.
    if (!ProjectRunAuthority.current(project.id)) throw error;
    throwIfWorkflowMutationPending(project.id);
    await assertTerminalArtifactIsolation(project, git);
  }
}

export async function completeMergedTaskSessionPullRequest(options: {
  trello: TrelloClient;
  git: GitClient;
  github?: GitHubClient;
  project: ProjectConfig;
  card: TrelloCard;
  pullRequest: PullRequestState;
  preparedConflict?: PreparedConflictHandoff;
  preserveWorktree?: boolean;
  completionComment?: string;
  emailNotifier?: EmailNotifier;
  signal: AbortSignal;
}): Promise<void> {
  const { trello, git, project, card, pullRequest, signal } = options;
  const cardLog = logger.child({ projectId: project.id, cardId: card.id });
  if (signal.aborted) return;
  if (pullRequest.state !== "MERGED" || pullRequest.mergedAt === null)
    throw new Error("Completion requires a verified merged pull request");
  const branch = taskResources(project, card.id).branch;
  await clearTerminalActivity(options.github, project, pullRequest.url, cardLog);
  if (!options.preserveWorktree) {
    const remoteHead = await git.getRemoteBranchSha(
      project.repository.path,
      "origin",
      branch,
      project,
    );
    if (signal.aborted) return;
    if (remoteHead !== null) {
      if (remoteHead !== pullRequest.headRefOid)
        throw new Error("Terminal remote branch differs from the verified PR head; preserving it");
      try {
        await git.deleteRemoteBranch(
          project.repository.path,
          "origin",
          branch,
          project,
          remoteHead,
        );
      } catch (error) {
        if (!isMissingBranchDeletionError(error)) throw error;
        if (await git.remoteBranchExists(project.repository.path, "origin", branch, project)) {
          throw error;
        }
      }
    }
  }

  if (!options.preserveWorktree)
    clearTerminalConflict(project, card, options.preparedConflict, cardLog);
  const alreadyDone = card.idList === project.trello.doneListId;
  if (!alreadyDone) {
    if (options.emailNotifier && (options.emailNotifier.isEventEnabled?.("done") ?? true))
      enqueueNotification(
        options.emailNotifier,
        project.id,
        "done",
        pullRequest.url,
        buildCompletionEmail({
          project,
          card,
          pullRequestUrl: pullRequest.url,
        }),
        {
          cardId: card.id,
          listId: project.trello.doneListId,
          boardId: project.trello.boardId,
          dueComplete: true,
        },
      );
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
    cardLog.event(`Merged pull request transitioned card to Done: ${pullRequest.url}`);
    await notifyCompletion(
      options.emailNotifier,
      { project, card, pullRequestUrl: pullRequest.url },
      cardLog,
    );
  }
  if (
    options.completionComment !== undefined &&
    (!alreadyDone || ProjectRunAuthority.current(project.id))
  ) {
    try {
      await trello.addComment(card.id, options.completionComment);
    } catch (error) {
      throwIfWorkflowMutationPending(project.id);
      cardLog.warn(`Could not add merged PR completion note: ${message(error)}`);
    }
  }
  if (options.preserveWorktree) {
    cardLog.warn(
      "Task artifacts preserved after human merge; interrupted or unshipped work remains available for recovery",
    );
  } else {
    await cleanupTerminalWorktree(git, project, card, cardLog, signal, pullRequest.headRefOid!);
  }
}

export async function returnClosedTaskSessionPullRequestToBacklog(options: {
  trello: TrelloClient;
  git: GitClient;
  github?: GitHubClient;
  project: ProjectConfig;
  card: TrelloCard;
  pullRequest: PullRequestState;
  preparedConflict?: PreparedConflictHandoff;
  signal: AbortSignal;
  preserveWorktree?: boolean;
}): Promise<void> {
  const { trello, git, project, card, pullRequest, signal } = options;
  const cardLog = logger.child({ projectId: project.id, cardId: card.id });
  if (signal.aborted) return;
  if (pullRequest.state !== "CLOSED" || pullRequest.mergedAt !== null)
    throw new Error("Backlog closure requires a verified unmerged pull request");
  await clearTerminalActivity(options.github, project, pullRequest.url, cardLog);
  if (!options.preserveWorktree)
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
    cardLog.event(`Closed pull request returned card to Backlog: ${pullRequest.url}`);
  }
  // The move and explanatory comment are separate obligations. In particular,
  // finding the card in Backlog after restart does not prove comment delivery.
  // The concrete adapter reconciles its durable correlation identity rather
  // than resending a comment whose acceptance is uncertain.
  await trello.addComment(card.id, closedPrComment(pullRequest.url));
  if (options.preserveWorktree) {
    cardLog.warn(
      "Task artifacts preserved after human PR closure; interrupted or unshipped work remains available for recovery",
    );
  } else {
    // Read the actual retained closed-PR history, even when the recorded head
    // equals the terminal head. An unavailable API is not preservation proof.
    if (!options.github || !pullRequest.headRefOid)
      throw new Error("Closed PR history is unavailable; preserving artifacts");
    let commits: string[];
    try {
      commits = await options.github.getPullRequestCommitShas({
        cwd: project.repository.path,
        repository: project.repository.github,
        pullRequestNumber: Number(new URL(pullRequest.url).pathname.split("/").at(-1)),
        project,
      });
      if (commits.at(-1) !== pullRequest.headRefOid)
        throw new Error("Closed PR history does not preserve the implementation");
    } catch {
      await assertTerminalArtifactIsolation(project, git);
      cardLog.warn(
        "Closed PR history is unavailable; isolated local implementation remains preserved",
      );
      return;
    }
    await cleanupTerminalWorktree(git, project, card, cardLog, signal, pullRequest.headRefOid);
  }
}

async function clearTerminalActivity(
  github: GitHubClient | undefined,
  project: ProjectConfig,
  pullRequestUrl: string,
  cardLog: Logger,
): Promise<void> {
  if (typeof github?.updatePullRequestDescriptionStatus !== "function") return;
  try {
    await github.updatePullRequestDescriptionStatus({
      cwd: project.repository.path,
      repository: project.repository.github,
      pullRequestUrl,
      status: null,
      project,
    });
  } catch (error) {
    if (!(error instanceof MalformedManagedPullRequestStatusError)) throw error;
    cardLog.warn(
      "Human-edited status markers are ambiguous; terminal outcome preserves the PR body instead of overwriting it",
    );
  }
}
