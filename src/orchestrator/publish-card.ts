import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import { logger } from "../logging/logger.js";
import {
  notifyHumanReview,
  type EmailNotifier,
} from "../notifications/email-notifier.js";
import {
  TrelloRequestAbortedError,
  type TrelloCard,
  type TrelloClient,
} from "../trello/trello-client.js";
import { buildPullRequestDescriptionPrompt } from "../opencode/build-pull-request-description-prompt.js";
import {
  type OpenCodeClient,
  type OpenCodeRunResult,
} from "../opencode/opencode-client.js";
import {
  parsePullRequestDescription,
  type PullRequestDescription,
} from "../opencode/pull-request-description.js";

import { toFailureError } from "./failure-diagnostic.js";
import {
  completeAutoMergedCard,
  mergePullRequestForAutoMerge,
} from "./auto-merge.js";
import { PublishedCardStateError } from "./published-card-state-error.js";
import { getElapsedWorkflowTime } from "./workflow-duration.js";
import { WorkflowError } from "./workflow-error.js";

export interface PublishCardOptions {
  trello: TrelloClient;
  git: GitClient;
  github: GitHubClient;
  opencode?: OpenCodeClient;
  project: ProjectConfig;
  card: TrelloCard;
  worktreePath: string;
  branch: string;
  commitSha: string;
  reviewResult: string;
  remediationResult: string;
  pullRequestDescription?: PullRequestDescription;
  sessionLogPath?: string;
  emailNotifier?: EmailNotifier;
  signal?: AbortSignal;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasOpenCodePermissionDenial(result: OpenCodeRunResult): boolean {
  const output = `${result.output}\n${result.errorOutput}`.toLowerCase();

  return (
    output.includes("auto-rejecting") ||
    output.includes("rejected permission") ||
    output.includes("permission denied")
  );
}

function renderPullRequestBody(
  card: TrelloCard,
  description: PullRequestDescription | undefined,
): string {
  if (description === undefined) {
    return [
      `Trello: ${card.url}`,
      "",
      "Implemented automatically by Agent Orchestrator.",
    ].join("\n");
  }

  return [
    `Trello: ${card.url}`,
    "",
    description.summary,
    "",
    "## Changes",
    ...description.changes.map((change) => `- ${change}`),
    "",
    "## Validation",
    ...(description.validation.length === 0
      ? ["- No validation or test results were provided."]
      : description.validation.map((result) => `- ${result}`)),
    "",
    "Implemented automatically by Agent Orchestrator.",
  ].join("\n");
}

async function generatePullRequestDescription(options: {
  git: GitClient;
  opencode: OpenCodeClient;
  project: ProjectConfig;
  card: TrelloCard;
  worktreePath: string;
  commitSha: string;
  reviewResult: string;
  remediationResult: string;
  signal: AbortSignal;
  sessionLogPath?: string;
  cardLog: ReturnType<typeof logger.child>;
}): Promise<PullRequestDescription> {
  const {
    git,
    opencode,
    project,
    card,
    worktreePath,
    commitSha,
    reviewResult,
    remediationResult,
    signal,
    sessionLogPath,
    cardLog,
  } = options;

  let changedFiles: string;
  let commitMessage: string;

  try {
    changedFiles =
      typeof git.getChangedFiles === "function"
        ? await git.getChangedFiles(
            worktreePath,
            `origin/${project.repository.defaultBranch}`,
          )
        : "";
    commitMessage =
      typeof git.getCommitMessage === "function"
        ? await git.getCommitMessage(worktreePath)
        : "";
  } catch (error) {
    throw new WorkflowError(
      "Git/GitHub",
      `Could not collect final commit context for pull request description: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }

  const validationResults = [
    project.repository.validationCommand === undefined
      ? "No validation command was configured; validation/test result is unavailable."
      : `Configured validation command \`${project.repository.validationCommand}\` was supplied to modifying OpenCode sessions, but the orchestrator did not execute it; its result is unavailable.`,
    `Automated review result: ${reviewResult}.`,
    `Automated remediation result: ${remediationResult}.`,
  ];

  cardLog.event("Starting OpenCode pull request description generation...");

  const result = await opencode.run({
    cwd: worktreePath,
    model: project.opencode.commit.model,
    variant: project.opencode.commit.variant,
    timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
    prompt: buildPullRequestDescriptionPrompt(card, {
      changedFiles,
      commitSha,
      commitMessage,
      validationResults,
    }),
    signal,
    ...(sessionLogPath === undefined ? {} : { sessionLogPath }),
    sessionLabel: "OpenCode pull request description",
  });

  if (result.exitCode !== 0) {
    if (hasOpenCodePermissionDenial(result)) {
      throw new WorkflowError(
        "OpenCode permissions",
        "OpenCode was denied permission during pull request description generation",
      );
    }

    throw new WorkflowError(
      "OpenCode",
      `OpenCode pull request description generation exited with code ${result.exitCode}${result.errorOutput.trim().length > 0 ? `: ${result.errorOutput.trim()}` : ""}`,
      { cause: result },
    );
  }

  try {
    const description = parsePullRequestDescription(result.output);

    cardLog.event("OpenCode pull request description generated");

    return description;
  } catch (error) {
    throw new WorkflowError(
      "OpenCode",
      `OpenCode pull request description returned an invalid structured result: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
}

export async function publishCard({
  trello,
  git,
  github,
  opencode,
  project,
  card,
  worktreePath,
  branch,
  reviewResult,
  remediationResult,
  pullRequestDescription,
  sessionLogPath,
  emailNotifier,
  signal,
}: PublishCardOptions): Promise<void> {
  const cardLog = logger.child({
    projectId: project.id,
    cardId: card.id,
  });

  let pullRequest;
  let publishedCommitSha: string;
  let finalPullRequestDescription = pullRequestDescription;

  try {
    if (signal?.aborted) {
      throw new TrelloRequestAbortedError();
    }

    const currentBranch = await git.getCurrentBranch(worktreePath);

    if (currentBranch !== branch) {
      throw new Error(
        `Publication worktree is on branch "${currentBranch}", expected "${branch}"`,
      );
    }

    const defaultBranchRef = `origin/${project.repository.defaultBranch}`;

    cardLog.event(
      `Fetching latest ${defaultBranchRef} before publishing ${branch}...`,
    );

    if (signal?.aborted) {
      throw new TrelloRequestAbortedError();
    }

    try {
      await git.fetch(
        worktreePath,
        "origin",
        project.repository.defaultBranch,
        project,
      );
    } catch (error) {
      throw new WorkflowError(
        "Git/GitHub",
        `Failed to fetch ${defaultBranchRef} before publishing ${branch}: ${getErrorMessage(error)}. The task worktree and branch were preserved; resolve the Git failure and retry.`,
        { cause: error },
      );
    }

    if (signal?.aborted) {
      throw new TrelloRequestAbortedError();
    }

    cardLog.event(`Rebasing ${branch} onto ${defaultBranchRef}...`);

    try {
      await git.rebase(
        worktreePath,
        defaultBranchRef,
        project.repository.gitIdentity,
      );
    } catch (error) {
      throw new WorkflowError(
        "Git/GitHub",
        `Failed to rebase ${branch} onto ${defaultBranchRef}: ${getErrorMessage(error)}. Resolve any conflicts in the preserved task worktree, then retry publication.`,
        { cause: error },
      );
    }

    publishedCommitSha = await git.getHeadSha(worktreePath);

    cardLog.event(`Publication commit is ${publishedCommitSha}`);

    if (opencode !== undefined) {
      finalPullRequestDescription = await generatePullRequestDescription({
        git,
        opencode,
        project,
        card,
        worktreePath,
        commitSha: publishedCommitSha,
        reviewResult,
        remediationResult,
        signal: signal ?? new AbortController().signal,
        cardLog,
        ...(sessionLogPath === undefined ? {} : { sessionLogPath }),
      });
    }

    const remoteCommitSha =
      typeof git.getRemoteBranchSha === "function"
        ? await git.getRemoteBranchSha(worktreePath, "origin", branch, project)
        : null;

    if (remoteCommitSha === publishedCommitSha) {
      cardLog.event(
        `Branch ${branch} is already pushed at ${publishedCommitSha}`,
      );
    } else {
      if (
        remoteCommitSha !== null &&
        typeof git.isAncestor === "function" &&
        !(await git.isAncestor(
          worktreePath,
          remoteCommitSha,
          publishedCommitSha,
        ))
      ) {
        throw new Error(
          `Refusing to publish ${branch}: rebasing produced ${publishedCommitSha}, which is not a fast-forward descendant of the remote commit ${remoteCommitSha}. A non-fast-forward update would be required; the branch was not pushed. The task worktree and branch were preserved for diagnosis and retry.`,
        );
      }

      if (signal?.aborted) {
        throw new TrelloRequestAbortedError();
      }

      cardLog.event(`Pushing branch ${branch}...`);

      await git.push(worktreePath, "origin", branch, project);

      cardLog.event("Branch pushed");
    }

    cardLog.info("Checking for existing pull request...");

    if (signal?.aborted) {
      throw new TrelloRequestAbortedError();
    }

    pullRequest = await github.findPullRequest({
      cwd: worktreePath,
      repository: project.repository.github,
      headBranch: branch,
      project,
    });

    if (pullRequest) {
      cardLog.event(`Existing pull request found: ${pullRequest.url}`);
    } else {
      if (signal?.aborted) {
        throw new TrelloRequestAbortedError();
      }

      cardLog.event("Creating pull request...");

      pullRequest = await github.createPullRequest({
        cwd: worktreePath,
        repository: project.repository.github,
        baseBranch: project.repository.defaultBranch,
        headBranch: branch,
        title: card.name,
        body: renderPullRequestBody(card, finalPullRequestDescription),
        project,
      });

      cardLog.event(`Pull request created: ${pullRequest.url}`);
    }

    if (project.autoMerge) {
      cardLog.event(`Auto-merging pull request: ${pullRequest.url}`);

      await mergePullRequestForAutoMerge(
        github,
        project,
        card,
        pullRequest.url,
        publishedCommitSha,
        worktreePath,
        signal,
      );

      cardLog.event(`Pull request auto-merged: ${pullRequest.url}`);
    }
  } catch (error) {
    if (error instanceof TrelloRequestAbortedError) {
      throw error;
    }

    if (error instanceof WorkflowError) {
      throw error;
    }

    const publicationError = toFailureError(error);

    throw new WorkflowError("Git/GitHub", publicationError.message, {
      cause: error,
    });
  }

  if (signal?.aborted) {
    throw new TrelloRequestAbortedError();
  }

  if (project.autoMerge) {
    await completeAutoMergedCard({
      trello,
      project,
      card,
      pullRequestUrl: pullRequest.url,
      commitSha: publishedCommitSha,
      reviewResult,
      remediationResult,
      cardLog,
      ...(emailNotifier === undefined ? {} : { emailNotifier }),
      ...(signal === undefined ? {} : { signal }),
    });

    return;
  }

  cardLog.event("Moving Trello card to Human Review...");

  try {
    await trello.moveCard(card.id, project.trello.reviewListId);
  } catch (error) {
    if (error instanceof TrelloRequestAbortedError) {
      throw error;
    }

    throw new PublishedCardStateError(
      `Pull request ${pullRequest.url} was published, but the Trello card could not be moved to Human Review`,
      {
        cause: error,
      },
    );
  }

  cardLog.event("Trello card moved to Human Review");

  const elapsedWorkflowTime = await getElapsedWorkflowTime(
    trello,
    project,
    card.id,
    cardLog,
  );

  await notifyHumanReview(
    emailNotifier,
    {
      project,
      card,
      pullRequestUrl: pullRequest.url,
      commitSha: publishedCommitSha,
      reviewResult,
      remediationResult,
      ...(elapsedWorkflowTime === undefined ? {} : { elapsedWorkflowTime }),
      publicationContext:
        "The pull request was published and the card was moved to Human Review by the implementation workflow.",
    },
    cardLog,
  );

  const comment = [
    "Agent Orchestrator completed successfully.",
    "",
    `PR: ${pullRequest.url}`,
    `Commit: ${publishedCommitSha}`,
    `Review: ${reviewResult}`,
    `Remediation: ${remediationResult}`,
    ...(elapsedWorkflowTime === undefined
      ? []
      : [`Elapsed workflow time: ${elapsedWorkflowTime}`]),
  ].join("\n");

  try {
    await trello.addComment(card.id, comment);

    cardLog.info("Trello card updated with workflow summary");
  } catch (error) {
    cardLog.error(
      `Failed to add workflow summary to Trello card: ${getErrorMessage(error)}`,
    );
  }
}
