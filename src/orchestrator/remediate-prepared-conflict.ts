import path from "node:path";

import type { ProjectConfig } from "../config/config.js";
import { getExistingPreparedConflictWorktree } from "../git/prepare-worktree.js";
import type { GitClient } from "../git/git-client.js";
import { getSessionLogPath } from "../logging/session-log.js";
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
import type { TrelloCard } from "../trello/trello-client.js";

import { annotateCardFailure } from "./failure-diagnostic.js";
import {
  clearPreparedConflict,
  readPreparedConflict,
  type PreparedConflictHandoff,
} from "./prepared-conflict-state.js";
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
  opencode: OpenCodeClient;
  commands: CommandRunner;
  project: ProjectConfig;
  card: TrelloCard;
  handoff: PreparedConflictHandoff;
  signal: AbortSignal;
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

export async function remediatePreparedConflict(
  options: RemediatePreparedConflictOptions,
): Promise<void> {
  const branch = `agent/${options.card.id}`;
  const worktreePath = path.join(
    options.project.repository.worktreeRoot,
    options.card.id,
  );
  const sessionLogPath = getSessionLogPath(options.project.id, options.card.id);

  try {
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
      worktree.branch !== branch ||
      worktree.rebase === null
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

    const remainingRebase = await options.git.getRebaseState(worktree.path);
    const conflictedPaths = await options.git.getConflictedPaths(worktree.path);

    if (remainingRebase !== null || conflictedPaths.length > 0) {
      throw fail(
        options,
        "Git/GitHub",
        "verifying completed rebase",
        new Error(
          remainingRebase === null
            ? `unmerged paths remain: ${conflictedPaths.join(", ")}`
            : "Git rebase is still active; all conflict stops must be completed",
        ),
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

    if (validationCommand !== undefined) {
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
        throw fail(options, "Git/GitHub", "repository validation", error);
      }

      if (validation.exitCode !== 0) {
        throw fail(
          options,
          "Git/GitHub",
          "repository validation",
          new Error(
            `Validation command exited with code ${validation.exitCode}`,
          ),
        );
      }
    }

    throwIfSignalAborted(options.signal);

    const remoteTaskSha = await options.git.getRemoteBranchSha(
      worktree.path,
      "origin",
      branch,
      options.project,
    );

    if (
      remoteTaskSha === null ||
      !isGitSha(remoteTaskSha) ||
      remoteTaskSha !== persistedHandoff.expectedRemoteTaskSha
    ) {
      throw fail(
        options,
        "Git/GitHub",
        "authoritative remote SHA verification",
        new Error(
          remoteTaskSha === null
            ? "The remote task branch is missing"
            : !isGitSha(remoteTaskSha)
              ? "Git returned a malformed authoritative remote SHA"
              : `The remote task branch changed from ${persistedHandoff.expectedRemoteTaskSha} to ${remoteTaskSha}`,
        ),
      );
    }

    throwIfSignalAborted(options.signal);

    await options.git.pushWithLease(
      worktree.path,
      "origin",
      branch,
      persistedHandoff.expectedRemoteTaskSha,
      options.project,
    );

    clearPreparedConflict(options.project, options.card.id);
  } catch (error) {
    throwIfAborted(error);

    if (error instanceof PreparedConflictRemediationError) {
      throw error;
    }

    if (error instanceof OpenCodeTimeoutError) {
      throw fail(options, "OpenCode", "OpenCode conflict remediation", error);
    }

    throw fail(options, "Git/GitHub", "prepared conflict remediation", error);
  }
}
