import type { ProjectConfig } from "../config/config.js";
import type { GitHubClient } from "../github/github-client.js";
import { removeSessionLog } from "../logging/session-log.js";
import type { Logger } from "../logging/logger.js";
import {
  notifyCompletion,
  type EmailNotifier,
} from "../notifications/email-notifier.js";
import {
  TrelloRequestAbortedError,
  type TrelloCard,
  type TrelloClient,
} from "../trello/trello-client.js";

import { annotateCardFailure } from "./failure-diagnostic.js";
import { PublishedCardStateError } from "./published-card-state-error.js";
import { WorkflowError } from "./workflow-error.js";

export interface AutoMergeDetails {
  trello: TrelloClient;
  project: ProjectConfig;
  card: TrelloCard;
  pullRequestUrl: string;
  commitSha: string;
  reviewResult: string;
  remediationResult: string;
  cardLog: Logger;
  emailNotifier?: EmailNotifier;
  signal?: AbortSignal;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function mergePullRequestForAutoMerge(
  github: GitHubClient,
  project: ProjectConfig,
  card: TrelloCard,
  pullRequestUrl: string,
  commitSha: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new TrelloRequestAbortedError();
  }

  try {
    await github.mergePullRequest({
      cwd,
      repository: project.repository.github,
      pullRequestUrl,
      commitSha,
    });
  } catch (error) {
    const mergeError = new WorkflowError(
      "Git/GitHub",
      `Could not auto-merge pull request ${pullRequestUrl}: ${getErrorMessage(error)}`,
      { cause: error },
    );

    annotateCardFailure(mergeError, project.id, card.id);
    throw mergeError;
  }

  if (signal?.aborted) {
    throw new TrelloRequestAbortedError();
  }
}

export function buildAutoMergeSummary(details: {
  pullRequestUrl: string;
  commitSha: string;
  reviewResult: string;
  remediationResult: string;
}): string {
  return [
    "Agent Orchestrator completed an auto-merged implementation.",
    "",
    "Status: Auto-merged",
    `Pull request URL: ${details.pullRequestUrl}`,
    `Final published commit: ${details.commitSha}`,
    `Review: ${details.reviewResult}`,
    `Remediation: ${details.remediationResult}`,
  ].join("\n");
}

export async function completeAutoMergedCard({
  trello,
  project,
  card,
  pullRequestUrl,
  commitSha,
  reviewResult,
  remediationResult,
  cardLog,
  emailNotifier,
  signal,
}: AutoMergeDetails): Promise<void> {
  if (signal?.aborted) {
    return;
  }

  try {
    await trello.moveCard(card.id, project.trello.doneListId, {
      dueComplete: true,
    });
  } catch (error) {
    if (error instanceof TrelloRequestAbortedError) {
      throw error;
    }

    const stateError = new PublishedCardStateError(
      `Pull request ${pullRequestUrl} was merged, but the Trello card could not be moved to Done`,
      { cause: error },
    );

    annotateCardFailure(stateError, project.id, card.id);
    throw stateError;
  }

  cardLog.event("Auto-merged card moved to Done");

  await notifyCompletion(
    emailNotifier,
    {
      project,
      card,
      pullRequestUrl,
    },
    cardLog,
  );

  try {
    await trello.addComment(
      card.id,
      buildAutoMergeSummary({
        pullRequestUrl,
        commitSha,
        reviewResult,
        remediationResult,
      }),
    );

    cardLog.info("Trello card updated with auto-merge summary");
  } catch (error) {
    cardLog.error(
      `Failed to add auto-merge summary to Trello card: ${getErrorMessage(error)}`,
    );
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
