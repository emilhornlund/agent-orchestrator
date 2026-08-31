import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import { logger } from "../logging/logger.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";

import { toFailureError } from "./failure-diagnostic.js";
import { PublishedCardStateError } from "./published-card-state-error.js";
import {
  formatWorkflowDuration,
  selectAutomatedWorkflowPass,
} from "./workflow-duration.js";
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getElapsedWorkflowLine(
  trello: TrelloClient,
  project: ProjectConfig,
  cardId: string,
  cardLog: ReturnType<typeof logger.child>,
): Promise<string | undefined> {
  try {
    if (typeof trello.getListTransitions !== "function") {
      throw new Error("Trello client does not provide list transition history");
    }

    const transitions = await trello.getListTransitions(cardId);

    if (transitions === null) {
      throw new Error(
        "Trello action history contains an incomplete list transition",
      );
    }

    const duration = selectAutomatedWorkflowPass(transitions, {
      readyListId: project.trello.readyListId,
      workingListId: project.trello.workingListId,
      reviewListId: project.trello.reviewListId,
      failedListId: project.trello.failedListId,
    });

    if (duration.pass === null) {
      throw new Error(duration.reason);
    }

    return `Elapsed workflow time: ${formatWorkflowDuration(duration.pass.durationMilliseconds)}`;
  } catch (error) {
    cardLog.warn(`Elapsed workflow time omitted: ${getErrorMessage(error)}`);

    return undefined;
  }
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
    const remoteCommitSha =
      typeof git.getRemoteBranchSha === "function"
        ? await git.getRemoteBranchSha(worktreePath, "origin", branch)
        : null;

    if (remoteCommitSha === commitSha) {
      cardLog.event(`Branch ${branch} is already pushed at ${commitSha}`);
    } else {
      cardLog.event(`Pushing branch ${branch}...`);

      await git.push(worktreePath, "origin", branch);

      cardLog.event("Branch pushed");
    }

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

    const publicationError = toFailureError(error);

    throw new WorkflowError("Git/GitHub", publicationError.message, {
      cause: error,
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

  const elapsedWorkflowLine = await getElapsedWorkflowLine(
    trello,
    project,
    card.id,
    cardLog,
  );

  const comment = [
    "Agent Orchestrator completed successfully.",
    "",
    `PR: ${pullRequest.url}`,
    `Commit: ${commitSha}`,
    `Review: ${reviewResult}`,
    `Remediation: ${remediationResult}`,
    ...(elapsedWorkflowLine === undefined ? [] : [elapsedWorkflowLine]),
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
