import path from "node:path";

import type { ProjectConfig } from "../config/config.js";
import { getExistingPreparedConflictWorktree } from "../git/prepare-worktree.js";
import type { GitClient } from "../git/git-client.js";
import { getSessionLogPath } from "../logging/session-log.js";
import type { GitHubClient } from "../github/github-client.js";
import type { ManagedPullRequestStatus } from "../github/pull-request-status.js";
import { logger } from "../logging/logger.js";
import { buildConflictRemediationPrompt } from "../opencode/build-conflict-remediation-prompt.js";
import {
  OpenCodeRunAbortedError,
  OpenCodeTimeoutError,
  type OpenCodeClient,
} from "../opencode/opencode-client.js";
import {
  CommandRunAbortedError,
  type CommandRunner,
} from "../process/command-runner.js";
import { runRepositorySetup } from "../process/run-setup.js";
import type { TrelloCard } from "../trello/trello-client.js";

import { annotateCardFailure } from "./failure-diagnostic.js";
import {
  PullRequestStatusPresentationError,
  updateMaintenanceStatus,
} from "./maintenance-status.js";
import {
  clearPreparedConflict,
  readPreparedConflict,
  type PreparedConflictHandoff,
} from "./prepared-conflict-state.js";
import {
  matchesReviewMaintenanceRepositoryState,
  readReviewMaintenanceState,
  writeReviewMaintenanceState,
  type ReviewMaintenanceState,
} from "./review-maintenance-state.js";
import {
  WorkflowError,
  type WorkflowFailureCategory,
} from "./workflow-error.js";

export const MAX_PREPARED_CONFLICT_REMEDIATION_ATTEMPTS = 3;

export class PreparedConflictRemediationError extends WorkflowError {
  constructor(
    category: WorkflowFailureCategory,
    message: string,
    options?: ErrorOptions,
  ) {
    super(category, message, options);
    this.name = "PreparedConflictRemediationError";
  }
}

export interface RemediatePreparedConflictOptions {
  git: GitClient;
  github?: GitHubClient;
  opencode: OpenCodeClient;
  commands: CommandRunner;
  project: ProjectConfig;
  card: TrelloCard;
  handoff: PreparedConflictHandoff;
  signal: AbortSignal;
  pullRequestUrl?: string;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isGitSha(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function hasPermissionDenial(output: string, errorOutput: string): boolean {
  const combined = `${output}\n${errorOutput}`.toLowerCase();

  return (
    combined.includes("auto-rejecting") ||
    combined.includes("rejected permission") ||
    combined.includes("permission denied")
  );
}

function fail(
  options: RemediatePreparedConflictOptions,
  category: WorkflowFailureCategory,
  operation: string,
  error: unknown,
): PreparedConflictRemediationError {
  const failure = new PreparedConflictRemediationError(
    category,
    `Could not remediate prepared rebase conflict for card "${options.card.name}" during ${operation}: ${getErrorMessage(error)}. The existing pull request, task branch, prepared-conflict handoff, and worktree were preserved.`,
    { cause: error },
  );

  annotateCardFailure(failure, options.project.id, options.card.id);
  return failure;
}

function throwIfAborted(error: unknown): void {
  if (
    error instanceof OpenCodeRunAbortedError ||
    error instanceof CommandRunAbortedError
  ) {
    throw error;
  }
}

function throwIfSignalAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new OpenCodeRunAbortedError();
  }
}

function createRemediationMaintenanceState(
  options: RemediatePreparedConflictOptions,
  handoff: PreparedConflictHandoff,
  headSha: string,
  validation: ReviewMaintenanceState["validation"],
  setupCompleted = options.project.repository.setupCommand === undefined,
): ReviewMaintenanceState {
  const setupCommand = options.project.repository.setupCommand;
  const validationCommand = options.project.repository.validationCommand;

  return {
    version: 1,
    kind: "review-maintenance",
    projectId: options.project.id,
    cardId: options.card.id,
    taskBranch: `agent/${options.card.id}`,
    defaultBranch: options.project.repository.defaultBranch,
    remoteTaskSha: handoff.expectedRemoteTaskSha,
    remoteDefaultSha: handoff.rebase.onto,
    effectiveHeadSha: headSha,
    ...(setupCommand === undefined ? {} : { setupCommand }),
    setupCompleted,
    ...(validationCommand === undefined ? {} : { validationCommand }),
    ...(validation === undefined ? {} : { validation }),
  };
}

async function verifyAuthoritativeRemoteTaskSha(
  options: RemediatePreparedConflictOptions,
  worktreePath: string,
  branch: string,
  expectedRemoteTaskSha: string,
  operation: string,
): Promise<void> {
  let remoteTaskSha: string | null;

  try {
    remoteTaskSha = await options.git.getRemoteBranchSha(
      worktreePath,
      "origin",
      branch,
      options.project,
    );
  } catch (error) {
    throw fail(options, "Git/GitHub", operation, error);
  }

  if (
    remoteTaskSha === null ||
    !isGitSha(remoteTaskSha) ||
    remoteTaskSha !== expectedRemoteTaskSha
  ) {
    throw fail(
      options,
      "Git/GitHub",
      operation,
      new Error(
        remoteTaskSha === null
          ? "The remote task branch is missing"
          : !isGitSha(remoteTaskSha)
            ? "Git returned a malformed authoritative remote SHA"
            : `The remote task branch changed from ${expectedRemoteTaskSha} to ${remoteTaskSha}`,
      ),
    );
  }
}

function replayValidationFailure(
  options: RemediatePreparedConflictOptions,
  state: ReviewMaintenanceState,
): PreparedConflictRemediationError {
  const failure = new PreparedConflictRemediationError(
    "Git/GitHub",
    state.validation?.reason ?? "The recorded repository validation failed",
  );

  annotateCardFailure(failure, options.project.id, options.card.id);
  return failure;
}

export async function remediatePreparedConflict(
  options: RemediatePreparedConflictOptions,
): Promise<void> {
  const branch = `agent/${options.card.id}`;
  const worktreePath = path.join(
    options.project.repository.worktreeRoot,
    options.card.id,
  );
  const sessionLogPath = getSessionLogPath(options.project.id, options.card.id);
  const cardLog = logger.child({
    projectId: options.project.id,
    cardId: options.card.id,
  });
  let statusStarted = false;

  const setStatus = async (
    status: ManagedPullRequestStatus | null,
    phase: string,
    bestEffort = false,
  ): Promise<void> => {
    if (options.pullRequestUrl === undefined) {
      return;
    }

    await updateMaintenanceStatus(
      options.github,
      options.project,
      options.card,
      options.pullRequestUrl,
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
    await setStatus(
      "resolving-conflicts",
      "starting prepared conflict remediation",
    );
    const persistedHandoff = readPreparedConflict(
      options.project,
      options.card.id,
    );

    if (
      persistedHandoff === null ||
      persistedHandoff.expectedRemoteTaskSha !==
        options.handoff.expectedRemoteTaskSha ||
      persistedHandoff.preparedAt !== options.handoff.preparedAt
    ) {
      throw new Error("Prepared conflict handoff changed before remediation");
    }

    const worktree = await getExistingPreparedConflictWorktree(
      options.git,
      options.project,
      options.card.id,
      persistedHandoff.rebase,
    );

    if (
      worktree === null ||
      worktree.path !== worktreePath ||
      worktree.branch !== branch
    ) {
      throw new Error(
        `Expected prepared remediation worktree ${worktreePath} on ${branch} was not found`,
      );
    }

    if (!(await options.git.isValidRepository(worktree.path))) {
      throw new Error(
        `Prepared remediation worktree ${worktree.path} is not a valid Git worktree`,
      );
    }

    if (worktree.rebase !== null) {
      const result = await options.opencode.run({
        cwd: worktree.path,
        model: options.project.opencode.remediation.model,
        variant: options.project.opencode.remediation.variant,
        timeoutMilliseconds: options.project.opencode.timeoutMinutes * 60_000,
        prompt: buildConflictRemediationPrompt(
          options.card,
          persistedHandoff,
          options.project.repository.validationCommand,
        ),
        signal: options.signal,
        sessionLogPath,
        sessionLabel: "OpenCode conflict remediation",
      });

      throwIfSignalAborted(options.signal);

      if (result.exitCode !== 0) {
        if (hasPermissionDenial(result.output, result.errorOutput)) {
          throw fail(
            options,
            "OpenCode permissions",
            "OpenCode conflict remediation",
            new Error(
              "OpenCode was denied permission during conflict remediation",
            ),
          );
        }

        throw fail(
          options,
          "OpenCode",
          "OpenCode conflict remediation",
          new Error(`OpenCode exited with code ${result.exitCode}`),
        );
      }
    }

    const remainingRebase = await options.git.getRebaseState(worktree.path);

    if (remainingRebase !== null) {
      throw fail(
        options,
        "Git/GitHub",
        "verifying completed rebase",
        new Error(
          "Git rebase is still active; all conflict stops must be completed",
        ),
      );
    }

    const conflictedPaths = await options.git.getConflictedPaths(worktree.path);

    if (conflictedPaths.length > 0) {
      throw fail(
        options,
        "Git/GitHub",
        "verifying completed rebase",
        new Error(`unmerged paths remain: ${conflictedPaths.join(", ")}`),
      );
    }

    const remediatedHead = await options.git.getHeadSha(worktree.path);

    if (!isGitSha(remediatedHead)) {
      throw fail(
        options,
        "Git/GitHub",
        "verifying completed rebase",
        new Error("Git returned a malformed remediated HEAD SHA"),
      );
    }

    if (remediatedHead === persistedHandoff.rebase.originalHead) {
      throw fail(
        options,
        "Git/GitHub",
        "verifying completed rebase",
        new Error(
          "The remediated HEAD is unchanged; the prepared rebase may have been aborted",
        ),
      );
    }

    if (
      !(await options.git.isAncestor(
        worktree.path,
        persistedHandoff.rebase.onto,
        remediatedHead,
      ))
    ) {
      throw fail(
        options,
        "Git/GitHub",
        "verifying completed rebase",
        new Error(
          `The remediated HEAD ${remediatedHead} does not contain rebase target ${persistedHandoff.rebase.onto}`,
        ),
      );
    }

    if (!(await options.git.isValidRepository(worktree.path))) {
      throw fail(
        options,
        "Git/GitHub",
        "verifying remediation worktree",
        new Error("The remediation worktree is no longer a valid Git worktree"),
      );
    }

    if ((await options.git.getCurrentBranch(worktree.path)) !== branch) {
      throw fail(
        options,
        "Git/GitHub",
        "verifying remediation branch",
        new Error(`The remediation worktree is not on ${branch}`),
      );
    }

    const status = await options.git.getStatus(worktree.path);

    if (status.trim().length > 0) {
      throw fail(
        options,
        "Git/GitHub",
        "verifying publication state",
        new Error(
          `The remediated worktree has uncommitted changes:\n${status}`,
        ),
      );
    }

    const validationCommand = options.project.repository.validationCommand;
    const setupCommand = options.project.repository.setupCommand;
    let recordedState: ReviewMaintenanceState | null;

    try {
      recordedState = readReviewMaintenanceState(
        options.project,
        options.card.id,
      );
    } catch (error) {
      throw fail(
        options,
        "Git/GitHub",
        "review maintenance state lookup",
        error,
      );
    }

    await verifyAuthoritativeRemoteTaskSha(
      options,
      worktree.path,
      branch,
      persistedHandoff.expectedRemoteTaskSha,
      "authoritative remote SHA verification before reusing validation failure",
    );

    const stateMatches =
      recordedState !== null &&
      matchesReviewMaintenanceRepositoryState(recordedState, {
        remoteTaskSha: persistedHandoff.expectedRemoteTaskSha,
        remoteDefaultSha: persistedHandoff.rebase.onto,
        effectiveHeadSha: remediatedHead,
        ...(setupCommand === undefined ? {} : { setupCommand }),
        ...(validationCommand === undefined ? {} : { validationCommand }),
      });

    if (
      stateMatches &&
      recordedState?.setupCompleted === true &&
      recordedState.validation?.outcome === "failed"
    ) {
      throw replayValidationFailure(options, recordedState);
    }

    if (
      setupCommand !== undefined &&
      (!stateMatches || recordedState?.setupCompleted !== true)
    ) {
      try {
        const setup = await runRepositorySetup(options.commands, {
          cwd: worktree.path,
          command: setupCommand,
          timeoutMilliseconds: options.project.opencode.timeoutMinutes * 60_000,
          signal: options.signal,
          sessionLogPath,
          sessionLabel: "Repository setup for Human Review",
        });

        if (setup.exitCode !== 0) {
          throw new Error(
            `Repository setup exited with code ${setup.exitCode}`,
          );
        }
      } catch (error) {
        throwIfAborted(error);
        throw fail(options, "Setup", "repository setup", error);
      }

      try {
        writeReviewMaintenanceState(
          options.project,
          options.card.id,
          createRemediationMaintenanceState(
            options,
            persistedHandoff,
            remediatedHead,
            undefined,
            true,
          ),
        );
        recordedState = readReviewMaintenanceState(
          options.project,
          options.card.id,
        );
      } catch (error) {
        throw fail(
          options,
          "Git/GitHub",
          "recording successful repository setup",
          error,
        );
      }
    }

    if (validationCommand !== undefined) {
      await setStatus(
        "validating",
        "repository validation after conflict remediation",
      );
      let validation;

      try {
        validation = await options.commands.run({
          cwd: worktree.path,
          command: validationCommand,
          timeoutMilliseconds: options.project.opencode.timeoutMinutes * 60_000,
          signal: options.signal,
          sessionLogPath,
          sessionLabel: "Repository validation after conflict remediation",
        });
      } catch (error) {
        throwIfAborted(error);
        const validationError = fail(
          options,
          "Git/GitHub",
          "repository validation",
          error,
        );

        try {
          writeReviewMaintenanceState(
            options.project,
            options.card.id,
            createRemediationMaintenanceState(
              options,
              persistedHandoff,
              remediatedHead,
              { outcome: "failed", reason: validationError.message },
              setupCommand === undefined ||
                recordedState?.setupCompleted === true,
            ),
          );
        } catch (stateError) {
          throw fail(
            options,
            "Git/GitHub",
            "recording repository validation failure",
            stateError,
          );
        }

        throw validationError;
      }

      if (validation.exitCode !== 0) {
        const validationError = fail(
          options,
          "Git/GitHub",
          "repository validation",
          new Error(
            `Validation command exited with code ${validation.exitCode}`,
          ),
        );

        try {
          writeReviewMaintenanceState(
            options.project,
            options.card.id,
            createRemediationMaintenanceState(
              options,
              persistedHandoff,
              remediatedHead,
              { outcome: "failed", reason: validationError.message },
              setupCommand === undefined ||
                recordedState?.setupCompleted === true,
            ),
          );
        } catch (stateError) {
          throw fail(
            options,
            "Git/GitHub",
            "recording repository validation failure",
            stateError,
          );
        }

        throw validationError;
      }

      try {
        writeReviewMaintenanceState(
          options.project,
          options.card.id,
          createRemediationMaintenanceState(
            options,
            persistedHandoff,
            remediatedHead,
            { outcome: "passed" },
            setupCommand === undefined ||
              recordedState?.setupCompleted === true,
          ),
        );
      } catch (error) {
        throw fail(
          options,
          "Git/GitHub",
          "recording successful repository validation",
          error,
        );
      }
    }

    throwIfSignalAborted(options.signal);

    await verifyAuthoritativeRemoteTaskSha(
      options,
      worktree.path,
      branch,
      persistedHandoff.expectedRemoteTaskSha,
      "authoritative remote SHA verification",
    );

    throwIfSignalAborted(options.signal);

    await setStatus(
      "updating-remote",
      "updating remote task branch after conflict remediation",
    );

    await options.git.pushWithLease(
      worktree.path,
      "origin",
      branch,
      persistedHandoff.expectedRemoteTaskSha,
      options.project,
    );

    try {
      await setStatus(null, "successful prepared conflict remediation", true);
    } catch (error) {
      if (!(error instanceof PullRequestStatusPresentationError)) {
        throw error;
      }

      cardLog.warn(
        `Housekeeping cleanup warning for project "${options.project.id}", card "${options.card.id}": could not remove the managed pull-request status from ${options.pullRequestUrl ?? "the existing pull request"}: ${getErrorMessage(error)}`,
      );
    }

    clearPreparedConflict(options.project, options.card.id);
  } catch (error) {
    throwIfAborted(error);

    if (
      statusStarted &&
      !(error instanceof PullRequestStatusPresentationError) &&
      !options.signal.aborted
    ) {
      try {
        await setStatus("failed", "failed prepared conflict remediation");
      } catch {
        // Keep the remediation failure primary when the failure presentation also fails.
      }
    }

    if (error instanceof PullRequestStatusPresentationError) {
      throw error;
    }

    if (error instanceof PreparedConflictRemediationError) {
      throw error;
    }

    if (error instanceof OpenCodeTimeoutError) {
      throw fail(options, "OpenCode", "OpenCode conflict remediation", error);
    }

    throw fail(options, "Git/GitHub", "prepared conflict remediation", error);
  }
}
