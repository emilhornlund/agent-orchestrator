import type { ProjectConfig } from "../config/config.js";
import { prepareReviewMaintenanceWorktree } from "../git/prepare-review-worktree.js";
import type { GitClient } from "../git/git-client.js";
import type { PreparedWorktree } from "../git/prepare-worktree.js";
import type {
  GitHubClient,
  PullRequestState,
} from "../github/github-client.js";
import { getPullRequestHeadRepositoryIdentity } from "../github/github-client.js";
import type { ManagedPullRequestStatus } from "../github/pull-request-status.js";
import { logger, type Logger } from "../logging/logger.js";
import { getSessionLogPath } from "../logging/session-log.js";
import {
  CommandRunAbortedError,
  type CommandRunner,
} from "../process/command-runner.js";
import { runRepositorySetup } from "../process/run-setup.js";
import { annotateCardFailure } from "./failure-diagnostic.js";
import {
  PullRequestStatusPresentationError,
  updateMaintenanceStatus,
} from "./maintenance-status.js";
import {
  readPreparedConflict,
  writePreparedConflict,
  type PreparedConflictHandoff,
} from "./prepared-conflict-state.js";
import { WorkflowError } from "./workflow-error.js";
import type { TrelloCard } from "../trello/trello-client.js";
import {
  matchesReviewMaintenanceRepositoryState,
  readReviewMaintenanceState,
  writeReviewMaintenanceState,
  type ReviewMaintenanceState,
} from "./review-maintenance-state.js";

export type ReviewMaintenanceResult =
  | "not-eligible"
  | "already-current"
  | "rebased"
  | "prepared-conflict"
  | "validation-failed";

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
    `Could not maintain Human Review pull request for card "${card.name}" during ${operation}: ${getErrorMessage(error)}. No cleanup or unrelated workflow transition was performed; the existing pull request and Git state remain available for diagnosis and retry.`,
    { cause: error },
  );

  annotateCardFailure(workflowError, project.id, card.id);
  return workflowError;
}

function isOwnedOpenMaintenancePullRequest(
  pullRequest: PullRequestState,
  project: ProjectConfig,
  branch: string,
): boolean {
  const isBehind =
    pullRequest.mergeable === "MERGEABLE" &&
    pullRequest.mergeStateStatus === "BEHIND";
  const isConflicted =
    pullRequest.mergeable === "CONFLICTING" ||
    pullRequest.mergeStateStatus === "DIRTY";

  return (
    pullRequest.state === "OPEN" &&
    pullRequest.baseRefName === project.repository.defaultBranch &&
    pullRequest.headRefName === branch &&
    getPullRequestHeadRepositoryIdentity(pullRequest) ===
      project.repository.github &&
    (isBehind || isConflicted)
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
    !isOwnedOpenMaintenancePullRequest(pullRequest, options.project, branch)
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
): Promise<PreparedWorktree & { created: boolean }> {
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

function setupMaintenanceError(
  project: ProjectConfig,
  card: TrelloCard,
  error: unknown,
): WorkflowError {
  const workflowError = new WorkflowError(
    "Setup",
    `Could not run repository setup for Human Review card "${card.name}": ${getErrorMessage(error)}. The existing pull request and worktree were preserved.`,
    { cause: error },
  );

  annotateCardFailure(workflowError, project.id, card.id);
  return workflowError;
}

function createMaintenanceState(
  project: ProjectConfig,
  cardId: string,
  values: {
    remoteTaskSha: string;
    remoteDefaultSha: string;
    effectiveHeadSha: string;
    setupCommand?: string;
    setupCompleted: boolean;
    validationCommand?: string;
    validation?: ReviewMaintenanceState["validation"];
  },
): ReviewMaintenanceState {
  return {
    version: 1,
    kind: "review-maintenance",
    projectId: project.id,
    cardId,
    taskBranch: `agent/${cardId}`,
    defaultBranch: project.repository.defaultBranch,
    remoteTaskSha: values.remoteTaskSha,
    remoteDefaultSha: values.remoteDefaultSha,
    effectiveHeadSha: values.effectiveHeadSha,
    ...(values.setupCommand === undefined
      ? {}
      : { setupCommand: values.setupCommand }),
    setupCompleted: values.setupCompleted,
    ...(values.validationCommand === undefined
      ? {}
      : { validationCommand: values.validationCommand }),
    ...(values.validation === undefined
      ? {}
      : { validation: values.validation }),
  };
}

function recordValidationFailure(
  options: ReviewMaintenanceOptions,
  remoteTaskSha: string,
  remoteDefaultSha: string,
  effectiveHeadSha: string,
  setupCommand: string | undefined,
  validationCommand: string,
  setupCompleted: boolean,
  validationError: Error,
): void {
  try {
    writeReviewMaintenanceState(
      options.project,
      options.card.id,
      createMaintenanceState(options.project, options.card.id, {
        remoteTaskSha,
        remoteDefaultSha,
        effectiveHeadSha,
        ...(setupCommand === undefined ? {} : { setupCommand }),
        setupCompleted,
        validationCommand,
        validation: {
          outcome: "failed",
          reason: validationError.message,
        },
      }),
    );
  } catch (stateError) {
    throw maintenanceError(
      options.project,
      options.card,
      "recording repository validation failure",
      stateError,
    );
  }
}

async function isReusableValidationFailure(
  options: ReviewMaintenanceOptions,
  worktree: PreparedWorktree & { created: boolean },
  state: ReviewMaintenanceState | null,
  remoteTaskSha: string,
  remoteDefaultSha: string,
): Promise<boolean> {
  if (worktree.created || state?.validation?.outcome !== "failed") {
    return false;
  }

  if (
    !state.setupCompleted ||
    !matchesReviewMaintenanceRepositoryState(state, {
      remoteTaskSha,
      remoteDefaultSha,
      effectiveHeadSha: state.effectiveHeadSha,
      ...(options.project.repository.setupCommand === undefined
        ? {}
        : { setupCommand: options.project.repository.setupCommand }),
      ...(options.project.repository.validationCommand === undefined
        ? {}
        : { validationCommand: options.project.repository.validationCommand }),
    })
  ) {
    return false;
  }

  try {
    return (
      (await options.git.getHeadSha(worktree.path)) === state.effectiveHeadSha
    );
  } catch (error) {
    throw maintenanceError(
      options.project,
      options.card,
      "checking recorded validation state",
      error,
    );
  }
}

export async function maintainReviewPullRequest(
  options: ReviewMaintenanceOptions,
): Promise<ReviewMaintenanceResult> {
  let statusStarted = false;
  const cardLog =
    options.cardLog ??
    logger.child({ projectId: options.project.id, cardId: options.card.id });

  const setStatus = async (
    status: ManagedPullRequestStatus | null,
    phase: string,
    bestEffort = false,
  ): Promise<void> => {
    await updateMaintenanceStatus(
      options.github,
      options.project,
      options.card,
      options.pullRequest.url,
      status,
      phase,
      cardLog,
      { bestEffort },
    );

    if (status !== null) {
      statusStarted = true;
    }
  };

  try {
    return await maintainReviewPullRequestCore(options, setStatus, cardLog);
  } catch (error) {
    if (
      statusStarted &&
      !(error instanceof PullRequestStatusPresentationError) &&
      !(error instanceof CommandRunAbortedError) &&
      !options.signal?.aborted
    ) {
      try {
        await setStatus("failed", "failed maintenance");
      } catch {
        // The presentation error is logged and the original Git failure remains primary.
      }
    }

    throw error;
  }
}

async function maintainReviewPullRequestCore(
  options: ReviewMaintenanceOptions,
  setStatus: (
    status: ManagedPullRequestStatus | null,
    phase: string,
    bestEffort?: boolean,
  ) => Promise<void>,
  cardLog: Logger,
): Promise<ReviewMaintenanceResult> {
  const branch = `agent/${options.card.id}`;
  const defaultBranchRef = `origin/${options.project.repository.defaultBranch}`;
  const sessionLogPath = getSessionLogPath(options.project.id, options.card.id);

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
      `Skipping maintenance for ${branch}: the pull request is no longer an owned, open, behind or conflicted pull request without current-head requested changes`,
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

  await setStatus("rebasing", "starting branch maintenance");

  const worktree = await prepareMaintenanceWorktree(options, branch);

  let recordedState: ReviewMaintenanceState | null;

  try {
    recordedState = readReviewMaintenanceState(
      options.project,
      options.card.id,
    );
  } catch (error) {
    throw maintenanceError(
      options.project,
      options.card,
      "review maintenance state lookup",
      error,
    );
  }

  if (
    await isReusableValidationFailure(
      options,
      worktree,
      recordedState,
      remoteTaskSha,
      remoteDefaultSha,
    )
  ) {
    await setStatus("failed", "unchanged repository validation failure");
    return "validation-failed";
  }

  if (options.signal?.aborted) {
    return "not-eligible";
  }

  if (!(await revalidatePullRequest(options, branch))) {
    cardLog.info(
      `Skipping maintenance for ${branch}: pull-request ownership or review evidence changed before Git maintenance`,
    );
    await setStatus(null, "maintenance eligibility changed");
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
      await setStatus(null, "already-current branch maintenance");
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
        await setStatus("resolving-conflicts", "prepared conflict handoff");
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
  const setupCommand = options.project.repository.setupCommand;
  const stateMatches =
    recordedState !== null &&
    matchesReviewMaintenanceRepositoryState(recordedState, {
      remoteTaskSha,
      remoteDefaultSha,
      effectiveHeadSha: rebasedSha,
      ...(setupCommand === undefined ? {} : { setupCommand }),
      ...(validationCommand === undefined ? {} : { validationCommand }),
    });

  if (
    setupCommand !== undefined &&
    (worktree.created ||
      !stateMatches ||
      recordedState?.setupCompleted !== true)
  ) {
    cardLog.event("Running repository setup before Human Review validation...");

    let setup;

    try {
      setup = await runRepositorySetup(options.commands, {
        cwd: worktree.path,
        command: setupCommand,
        timeoutMilliseconds:
          (options.project.opencode.timeoutMinutes ?? 360) * 60_000,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        sessionLogPath,
        sessionLabel: "Repository setup for Human Review",
      });
    } catch (error) {
      if (error instanceof CommandRunAbortedError) {
        throw error;
      }

      throw setupMaintenanceError(options.project, options.card, error);
    }

    if (setup.exitCode !== 0) {
      throw setupMaintenanceError(
        options.project,
        options.card,
        new Error(`Repository setup exited with code ${setup.exitCode}`),
      );
    }

    try {
      writeReviewMaintenanceState(
        options.project,
        options.card.id,
        createMaintenanceState(options.project, options.card.id, {
          remoteTaskSha,
          remoteDefaultSha,
          effectiveHeadSha: rebasedSha,
          setupCommand,
          setupCompleted: true,
          ...(validationCommand === undefined ? {} : { validationCommand }),
        }),
      );
      recordedState = readReviewMaintenanceState(
        options.project,
        options.card.id,
      );
    } catch (error) {
      throw maintenanceError(
        options.project,
        options.card,
        "recording successful repository setup",
        error,
      );
    }

    cardLog.event("Repository setup for Human Review passed");
  }

  if (validationCommand !== undefined) {
    if (
      stateMatches &&
      recordedState?.validation?.outcome === "passed" &&
      recordedState.setupCompleted
    ) {
      cardLog.info("Skipping unchanged successful repository validation");
    } else {
      await setStatus("validating", "repository validation");
      let validationResult;

      try {
        validationResult = await options.commands.run({
          cwd: worktree.path,
          command: validationCommand,
          timeoutMilliseconds:
            (options.project.opencode.timeoutMinutes ?? 360) * 60_000,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          sessionLogPath,
          sessionLabel: "Repository validation",
        });
      } catch (error) {
        if (error instanceof CommandRunAbortedError) {
          throw error;
        }

        const validationError = maintenanceError(
          options.project,
          options.card,
          "repository validation",
          error,
        );

        recordValidationFailure(
          options,
          remoteTaskSha,
          remoteDefaultSha,
          rebasedSha,
          setupCommand,
          validationCommand,
          setupCommand === undefined || recordedState?.setupCompleted === true,
          validationError,
        );
        throw validationError;
      }

      if (validationResult.exitCode !== 0) {
        const validationError = maintenanceError(
          options.project,
          options.card,
          "repository validation",
          new Error(
            `Validation command exited with code ${validationResult.exitCode}`,
          ),
        );

        recordValidationFailure(
          options,
          remoteTaskSha,
          remoteDefaultSha,
          rebasedSha,
          setupCommand,
          validationCommand,
          setupCommand === undefined || recordedState?.setupCompleted === true,
          validationError,
        );
        throw validationError;
      }

      try {
        writeReviewMaintenanceState(
          options.project,
          options.card.id,
          createMaintenanceState(options.project, options.card.id, {
            remoteTaskSha,
            remoteDefaultSha,
            effectiveHeadSha: rebasedSha,
            ...(setupCommand === undefined ? {} : { setupCommand }),
            setupCompleted:
              setupCommand === undefined ||
              recordedState?.setupCompleted === true,
            validationCommand,
            validation: { outcome: "passed" },
          }),
        );
      } catch (error) {
        throw maintenanceError(
          options.project,
          options.card,
          "recording successful repository validation",
          error,
        );
      }
    }
  }

  await setStatus("updating-remote", "updating remote task branch");

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

  try {
    await setStatus(null, "successful branch maintenance", true);
  } catch (error) {
    if (!(error instanceof PullRequestStatusPresentationError)) {
      throw error;
    }

    cardLog.warn(
      `Housekeeping cleanup warning for project "${options.project.id}", card "${options.card.id}": could not remove the managed pull-request status from ${options.pullRequest.url}: ${getErrorMessage(error)}`,
    );
  }

  cardLog.event(
    `Maintained existing pull request ${options.pullRequest.url}: rebased ${branch} onto ${defaultBranchRef} and updated it to ${rebasedSha} with force-with-lease`,
  );

  return "rebased";
}
