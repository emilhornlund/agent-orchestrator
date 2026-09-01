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

import { toFailureError } from "./failure-diagnostic.js";
import { PublishedCardStateError } from "./published-card-state-error.js";
import { getElapsedWorkflowTime } from "./workflow-duration.js";
import { WorkflowError } from "./workflow-error.js";

export interface PublishCardOptions {
  trello: TrelloClient;
  git: GitClient;
  github: GitHubClient;
  project: ProjectConfig;
  card: TrelloCard;
  worktreePath: string;
  branch: string;
  commitSha: string;
  reviewResult: string;
  remediationResult: string;
  emailNotifier?: EmailNotifier;
  signal?: AbortSignal;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function publishCard({
  trello,
  git,
  github,
  project,
  card,
  worktreePath,
  branch,
  reviewResult,
  remediationResult,
  emailNotifier,
  signal,
}: PublishCardOptions): Promise<void> {
  const cardLog = logger.child({
    projectId: project.id,
    cardId: card.id,
  });

  let pullRequest;
  let publishedCommitSha: string;

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
      await git.fetch(worktreePath, "origin", project.repository.defaultBranch);
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

    const remoteCommitSha =
      typeof git.getRemoteBranchSha === "function"
        ? await git.getRemoteBranchSha(worktreePath, "origin", branch)
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

      await git.push(worktreePath, "origin", branch);

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
        body: [
          `Trello: ${card.url}`,
          "",
          "Implemented automatically by Agent Orchestrator.",
        ].join("\n"),
      });

      cardLog.event(`Pull request created: ${pullRequest.url}`);
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
