import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";

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
  validationResult: string;
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
  validationResult,
  reviewResult,
  remediationResult,
}: PublishCardOptions): Promise<void> {
  let pullRequest;

  try {
    console.log(`[${project.id}] Pushing branch ${branch}...`);

    await git.push(worktreePath, "origin", branch);

    console.log(`[${project.id}] Branch pushed`);
    console.log(`[${project.id}] Checking for existing pull request...`);

    pullRequest = await github.findPullRequest({
      cwd: worktreePath,
      repository: project.repository.github,
      headBranch: branch,
    });

    if (pullRequest) {
      console.log(
        `[${project.id}] Existing pull request found: ${pullRequest.url}`,
      );
    } else {
      console.log(`[${project.id}] Creating pull request...`);

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

      console.log(`[${project.id}] Pull request created: ${pullRequest.url}`);
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

  console.log(`[${project.id}] Moving Trello card to Human Review...`);

  await trello.moveCard(card.id, project.trello.reviewListId);

  console.log(`[${project.id}] Trello card moved to Human Review`);

  const comment = [
    "Agent Orchestrator completed successfully.",
    "",
    `PR: ${pullRequest.url}`,
    `Commit: ${commitSha}`,
    `Validation: ${validationResult}`,
    `Review: ${reviewResult}`,
    `Remediation: ${remediationResult}`,
  ].join("\n");

  try {
    await trello.addComment(card.id, comment);

    console.log(`[${project.id}] Trello card updated with workflow summary`);
  } catch (error) {
    console.error(
      `[${project.id}] Failed to add workflow summary to Trello card: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
