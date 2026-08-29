import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import { logger } from "../logging/logger.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";

import { PublishedCardStateError } from "./published-card-state-error.js";
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
}

export async function publishCard({
  trello,
  git,
  github,
  project,
  card,
  worktreePath,
  branch,
  commitSha,
  reviewResult,
  remediationResult,
}: PublishCardOptions): Promise<void> {
  const cardLog = logger.child({
    projectId: project.id,
    cardId: card.id,
  });

  let pullRequest;

  try {
    cardLog.event(`Pushing branch ${branch}...`);

    await git.push(worktreePath, "origin", branch);

    cardLog.event("Branch pushed");
    cardLog.info("Checking for existing pull request...");

    pullRequest = await github.findPullRequest({
      cwd: worktreePath,
      repository: project.repository.github,
      headBranch: branch,
    });

    if (pullRequest) {
      cardLog.event(`Existing pull request found: ${pullRequest.url}`);
    } else {
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
    if (error instanceof WorkflowError) {
      throw error;
    }

    const publicationError =
      error instanceof Error ? error : new Error(String(error));

    throw new WorkflowError("Git/GitHub", publicationError.message, {
      cause: publicationError,
    });
  }

  cardLog.event("Moving Trello card to Human Review...");

  try {
    await trello.moveCard(card.id, project.trello.reviewListId);
  } catch (error) {
    throw new PublishedCardStateError(
      `Pull request ${pullRequest.url} was published, but the Trello card could not be moved to Human Review`,
      {
        cause: error,
      },
    );
  }

  cardLog.event("Trello card moved to Human Review");

  const comment = [
    "Agent Orchestrator completed successfully.",
    "",
    `PR: ${pullRequest.url}`,
    `Commit: ${commitSha}`,
    `Review: ${reviewResult}`,
    `Remediation: ${remediationResult}`,
  ].join("\n");

  try {
    await trello.addComment(card.id, comment);

    cardLog.info("Trello card updated with workflow summary");
  } catch (error) {
    cardLog.error(
      `Failed to add workflow summary to Trello card: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
