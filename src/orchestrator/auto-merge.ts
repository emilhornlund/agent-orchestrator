import type { ProjectConfig } from "../config/config.js";
import type { GitHubClient } from "../github/github-client.js";
import {
  TrelloRequestAbortedError,
  type TrelloCard,
} from "../trello/trello-client.js";

import { annotateCardFailure } from "./failure-diagnostic.js";
import { WorkflowError } from "./workflow-error.js";

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
      project,
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
