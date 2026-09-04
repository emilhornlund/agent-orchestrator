import type { ProjectConfig } from "../config/config.js";
import { prepareReviewMaintenanceWorktree } from "../git/prepare-review-worktree.js";
import type { GitClient } from "../git/git-client.js";
import type { PreparedWorktree } from "../git/prepare-worktree.js";
import type {
  GitHubClient,
  PullRequestState,
} from "../github/github-client.js";
import { logger, type Logger } from "../logging/logger.js";
import {
  CommandRunAbortedError,
  type CommandRunner,
} from "../process/command-runner.js";
import { annotateCardFailure } from "./failure-diagnostic.js";
import {
  readPreparedConflict,
  writePreparedConflict,
  type PreparedConflictHandoff,
} from "./prepared-conflict-state.js";
import { WorkflowError } from "./workflow-error.js";
import type { TrelloCard } from "../trello/trello-client.js";

export type ReviewMaintenanceResult =
  "not-eligible" | "already-current" | "rebased" | "prepared-conflict";

export interface ReviewMaintenanceOptions {
  git: GitClient;
  github: GitHubClient;
  commands: CommandRunner;
  project: ProjectConfig;
  card: TrelloCard;
  pullRequest: PullRequestState;
  signal?: AbortSignal;
  cardLog?: Logger;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isGitSha(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function maintenanceError(
  project: ProjectConfig,
  card: TrelloCard,
  operation: string,
  error: unknown,
): WorkflowError {
  const workflowError = new WorkflowError(
    "Git/GitHub",
    `Could not maintain Human Review pull request for card "${card.name}" during ${operation}: ${getErrorMessage(error)}. The existing pull request, card, task branch, and worktree were preserved; normal reconciliation can retry it.`,
    { cause: error },
  );

  annotateCardFailure(workflowError, project.id, card.id);
  return workflowError;
}

function isOwnedOpenBehindPullRequest(
  pullRequest: PullRequestState,
  project: ProjectConfig,
  branch: string,
): boolean {
  return (
    pullRequest.state === "OPEN" &&
    pullRequest.baseRefName === project.repository.defaultBranch &&
    pullRequest.headRefName === branch &&
    pullRequest.headRepositoryNameWithOwner === project.repository.github &&
    pullRequest.mergeable === "MERGEABLE" &&
    pullRequest.mergeStateStatus === "BEHIND"
  );
}

async function revalidatePullRequest(
  options: ReviewMaintenanceOptions,
  branch: string,
): Promise<boolean> {
  let pullRequest: PullRequestState | null;

  try {
    pullRequest = await options.github.findPullRequestState({
      cwd: options.project.repository.path,
      repository: options.project.repository.github,
      headBranch: branch,
      baseBranch: options.project.repository.defaultBranch,
      project: options.project,
    });
  } catch (error) {
    throw maintenanceError(
      options.project,
      options.card,
      "pull request revalidation",
      error,
    );
  }

  if (
    pullRequest === null ||
    pullRequest.url !== options.pullRequest.url ||
    !isOwnedOpenBehindPullRequest(pullRequest, options.project, branch)
  ) {
    return false;
  }

  try {
    const changesRequested =
      await options.github.findChangesRequestedPullRequest({
        cwd: options.project.repository.path,
        repository: options.project.repository.github,
        headBranch: branch,
        baseBranch: options.project.repository.defaultBranch,
        project: options.project,
      });

    return changesRequested === null;
  } catch (error) {
    throw maintenanceError(
      options.project,
      options.card,
      "requested-changes revalidation",
      error,
    );
  }
}

async function prepareMaintenanceWorktree(
  options: ReviewMaintenanceOptions,
  branch: string,
): Promise<PreparedWorktree> {
  try {
    return await prepareReviewMaintenanceWorktree(
      options.git,
      options.project,
      options.card.id,
    );
  } catch (error) {
    throw maintenanceError(
      options.project,
      options.card,
      `worktree preparation for ${branch}`,
      error,
    );
  }
}

export async function maintainReviewPullRequest(
  options: ReviewMaintenanceOptions,
): Promise<ReviewMaintenanceResult> {
  const branch = `agent/${options.card.id}`;
  const defaultBranchRef = `origin/${options.project.repository.defaultBranch}`;
  const cardLog =
    options.cardLog ??
    logger.child({ projectId: options.project.id, cardId: options.card.id });

  let existingConflict: PreparedConflictHandoff | null;

  try {
    existingConflict = readPreparedConflict(options.project, options.card.id);
  } catch (error) {
    throw maintenanceError(
      options.project,
      options.card,
      "prepared-conflict handoff lookup",
      error,
    );
  }

  if (existingConflict !== null) {
    cardLog.info(
      `Prepared conflict remains active for ${existingConflict.taskBranch}; skipping normal maintenance`,
    );
    return "prepared-conflict";
  }

  if (options.signal?.aborted) {
    return "not-eligible";
  }

  if (!(await revalidatePullRequest(options, branch))) {
    cardLog.info(
      `Skipping maintenance for ${branch}: the pull request is no longer an owned, open, conflict-free, behind pull request without current-head requested changes`,
    );
    return "not-eligible";
  }

  let remoteTaskSha: string | null;
  let remoteDefaultSha: string | null;

  try {
    remoteTaskSha = await options.git.getRemoteBranchSha(
      options.project.repository.path,
      "origin",
      branch,
      options.project,
    );
    remoteDefaultSha = await options.git.getRemoteBranchSha(
      options.project.repository.path,
      "origin",
      options.project.repository.defaultBranch,
      options.project,
    );
  } catch (error) {
    throw maintenanceError(
      options.project,
      options.card,
      "authoritative remote SHA lookup",
      error,
    );
  }

  if (remoteTaskSha === null || remoteDefaultSha === null) {
    cardLog.warn(
      `Skipping maintenance for ${branch}: the authoritative remote task or default branch SHA is missing`,
    );
    return "not-eligible";
  }

  if (!isGitSha(remoteTaskSha) || !isGitSha(remoteDefaultSha)) {
    throw maintenanceError(
      options.project,
      options.card,
      "authoritative remote SHA validation",
      new Error("Git returned a malformed authoritative remote SHA"),
    );
  }

  if (remoteTaskSha === remoteDefaultSha) {
    return "already-current";
  }

  const worktree = await prepareMaintenanceWorktree(options, branch);

  if (options.signal?.aborted) {
    return "not-eligible";
  }

  if (!(await revalidatePullRequest(options, branch))) {
    cardLog.info(
      `Skipping maintenance for ${branch}: pull-request ownership or review evidence changed before Git maintenance`,
    );
    return "not-eligible";
  }

  try {
    await options.git.fetch(worktree.path, "origin", branch, options.project);
    await options.git.resetHardTo(worktree.path, `origin/${branch}`);
    await options.git.fetch(
      worktree.path,
      "origin",
      options.project.repository.defaultBranch,
      options.project,
    );
  } catch (error) {
    throw maintenanceError(
      options.project,
      options.card,
      `fetching ${branch} and ${defaultBranchRef}`,
      error,
    );
  }

  if (options.signal?.aborted) {
    return "not-eligible";
  }

  try {
    if (await options.git.isAncestor(worktree.path, defaultBranchRef, "HEAD")) {
      return "already-current";
    }
  } catch (error) {
    throw maintenanceError(
      options.project,
      options.card,
      "checking whether the task branch is current",
      error,
    );
  }

  cardLog.event(
    `Rebasing ${branch} onto ${defaultBranchRef} for existing pull request`,
  );

  try {
    await options.git.rebase(
      worktree.path,
      defaultBranchRef,
      options.project.repository.gitIdentity,
    );
  } catch (error) {
    let rebaseState;

    try {
      rebaseState = await options.git.getRebaseState(worktree.path);
    } catch (stateError) {
      throw maintenanceError(
        options.project,
        options.card,
        `inspecting rebase state after ${branch} rebase failure`,
        stateError,
      );
    }

    if (rebaseState !== null) {
      let conflictedPaths: string[];

      try {
        conflictedPaths = await options.git.getConflictedPaths(worktree.path);
      } catch (pathsError) {
        throw maintenanceError(
          options.project,
          options.card,
          `collecting conflicted paths after ${branch} rebase failure`,
          pathsError,
        );
      }

      if (conflictedPaths.length > 0) {
        try {
          writePreparedConflict(
            options.project,
            options.card.id,
            remoteTaskSha,
            conflictedPaths,
            rebaseState,
          );
        } catch (handoffError) {
          throw maintenanceError(
            options.project,
            options.card,
            "recording prepared conflict handoff",
            handoffError,
          );
        }

        cardLog.event(
          `Prepared ${branch} for dedicated conflict remediation; active rebase and worktree were preserved`,
        );
        return "prepared-conflict";
      }
    }

    throw maintenanceError(
      options.project,
      options.card,
      `rebasing ${branch} onto ${defaultBranchRef}; conflict state was preserved for dedicated conflict handling`,
      error,
    );
  }

  let rebasedSha: string;

  try {
    rebasedSha = await options.git.getHeadSha(worktree.path);
  } catch (error) {
    throw maintenanceError(
      options.project,
      options.card,
      "reading rebased commit",
      error,
    );
  }

  const validationCommand = options.project.repository.validationCommand;

  if (validationCommand !== undefined) {
    let validationResult;

    try {
      validationResult = await options.commands.run({
        cwd: worktree.path,
        command: validationCommand,
        timeoutMilliseconds:
          (options.project.opencode.timeoutMinutes ?? 360) * 60_000,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (error instanceof CommandRunAbortedError) {
        throw error;
      }

      throw maintenanceError(
        options.project,
        options.card,
        "repository validation",
        error,
      );
    }

    if (validationResult.exitCode !== 0) {
      throw maintenanceError(
        options.project,
        options.card,
        "repository validation",
        new Error(
          `Validation command exited with code ${validationResult.exitCode}`,
        ),
      );
    }
  }

  try {
    await options.git.pushWithLease(
      worktree.path,
      "origin",
      branch,
      remoteTaskSha,
      options.project,
    );
  } catch (error) {
    throw maintenanceError(
      options.project,
      options.card,
      `force-with-lease update of ${branch}`,
      error,
    );
  }

  cardLog.event(
    `Maintained existing pull request ${options.pullRequest.url}: rebased ${branch} onto ${defaultBranchRef} and updated it to ${rebasedSha} with force-with-lease`,
  );

  return "rebased";
}
