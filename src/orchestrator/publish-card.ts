import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";

export interface PublishCardOptions {
  trello: TrelloClient;
  git: GitClient;
  github: GitHubClient;
  project: ProjectConfig;
  card: TrelloCard;
  worktreePath: string;
  branch: string;
}

export async function publishCard({
  trello,
  git,
  github,
  project,
  card,
  worktreePath,
  branch,
}: PublishCardOptions): Promise<void> {
  console.log(`[${project.id}] Pushing branch ${branch}...`);

  await git.push(worktreePath, "origin", branch);

  console.log(`[${project.id}] Branch pushed`);

  console.log(`[${project.id}] Creating pull request...`);

  const pullRequest = await github.createPullRequest({
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

  console.log(`[${project.id}] Moving Trello card to Human Review...`);

  await trello.moveCard(card.id, project.trello.reviewListId);

  console.log(`[${project.id}] Trello card moved to Human Review`);
}
