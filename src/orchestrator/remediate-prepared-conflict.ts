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
  WorkflowError,
  type WorkflowFailureCategory,
} from "./workflow-error.js";
import { writeTrustedCommitState } from "./trusted-commit-state.js";

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
  commands?: CommandRunner;
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
    `Could not remediate prepared rebase conflict for card "${options.card.name}" during ${operation}: ${getErrorMessage(error)}. The task branch, prepared-conflict handoff, and worktree were preserved.`,
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
      persistedHandoff.origin !== options.handoff.origin ||
      persistedHandoff.trustedTaskCommitSha !==
        options.handoff.trustedTaskCommitSha ||
      persistedHandoff.rebaseTargetSha !== options.handoff.rebaseTargetSha ||
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

    if (options.project.repository.setupCommand !== undefined) {
      if (options.commands === undefined) {
        throw fail(
          options,
          "Setup",
          "repository setup",
          new Error("A command runner is required for configured setup"),
        );
      }

      try {
        const setup = await runRepositorySetup(options.commands, {
          cwd: worktree.path,
          command: options.project.repository.setupCommand,
          timeoutMilliseconds: options.project.opencode.timeoutMinutes * 60_000,
          signal: options.signal,
          sessionLogPath,
          sessionLabel:
            "Repository setup for initial publication conflict remediation",
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

    const finalStatus = await options.git.getStatus(worktree.path);

    if (finalStatus.trim().length > 0) {
      throw fail(
        options,
        "Git/GitHub",
        "verifying publication state",
        new Error(
          `The remediated worktree has uncommitted changes:\n${finalStatus}`,
        ),
      );
    }

    try {
      writeTrustedCommitState(options.project, options.card.id, {
        version: 1,
        kind: "trusted-commit",
        projectId: options.project.id,
        cardId: options.card.id,
        taskBranch: branch,
        defaultBranch: options.project.repository.defaultBranch,
        commitSha: remediatedHead,
      });
    } catch (error) {
      throw fail(
        options,
        "Git/GitHub",
        "recording rebased trusted commit",
        error,
      );
    }

    try {
      await setStatus(null, "successful prepared conflict remediation", true);
    } catch (error) {
      cardLog.warn(
        `Could not clear the managed conflict status for ${options.pullRequestUrl ?? "the task PR"}: ${getErrorMessage(error)}`,
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
