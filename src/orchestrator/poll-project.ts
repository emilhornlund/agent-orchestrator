import type { ProjectConfig } from "../config/config.js";
import { buildCommitMessage } from "../git/build-commit-message.js";
import type { GitClient } from "../git/git-client.js";
import { prepareWorktree } from "../git/prepare-worktree.js";
import { buildTaskPrompt } from "../opencode/build-task-prompt.js";
import type { OpenCodeClient } from "../opencode/opencode-client.js";
import type { CommandRunner } from "../process/command-runner.js";
import type { TrelloClient } from "../trello/trello-client.js";

import { claimNextCard } from "./claim-next-card.js";

export async function pollProject(
  trello: TrelloClient,
  git: GitClient,
  opencode: OpenCodeClient,
  commands: CommandRunner,
  project: ProjectConfig,
): Promise<void> {
  const card = await claimNextCard(trello, project);

  if (!card) {
    console.log(`[${project.id}] No cards ready`);
    return;
  }

  console.log(`[${project.id}] Claimed card: ${card.name}`);

  const worktree = await prepareWorktree(git, project, card.id);

  console.log(`[${project.id}] Branch: ${worktree.branch}`);
  console.log(`[${project.id}] Worktree: ${worktree.path}`);
  console.log(`[${project.id}] Starting OpenCode...`);

  const result = await opencode.run({
    cwd: worktree.path,
    model: project.opencode.model,
    variant: project.opencode.variant,
    prompt: buildTaskPrompt(card),
  });

  if (result.exitCode !== 0) {
    throw new Error(`OpenCode exited with code ${result.exitCode}`);
  }

  console.log(`[${project.id}] OpenCode completed`);

  const status = await git.getStatus(worktree.path);

  if (status.length === 0) {
    throw new Error("OpenCode completed without repository changes");
  }

  console.log(`[${project.id}] Repository changes detected:`);

  for (const line of status.split("\n")) {
    console.log(`[${project.id}] ${line}`);
  }

  if (project.repository.validationCommand) {
    console.log(`[${project.id}] Running repository validation...`);

    const validation = await commands.run({
      cwd: worktree.path,
      command: project.repository.validationCommand,
    });

    if (validation.exitCode !== 0) {
      throw new Error(
        `Repository validation exited with code ${validation.exitCode}`,
      );
    }

    console.log(`[${project.id}] Repository validation passed`);
  }

  console.log(`[${project.id}] Staging repository changes...`);

  await git.stageAll(worktree.path);

  const stagedFiles = await git.getStagedFiles(worktree.path);

  if (stagedFiles.length === 0) {
    throw new Error("Repository changes disappeared before commit");
  }

  console.log(`[${project.id}] Staged files:`);

  for (const file of stagedFiles) {
    console.log(`[${project.id}] ${file}`);
  }

  const commitMessage = buildCommitMessage(card);

  console.log(`[${project.id}] Creating commit: ${commitMessage}`);

  await git.commit(worktree.path, commitMessage);

  const commitSha = await git.getHeadSha(worktree.path);

  console.log(`[${project.id}] Commit created: ${commitSha}`);
}
