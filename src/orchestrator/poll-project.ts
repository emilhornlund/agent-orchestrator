import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import { prepareWorktree } from "../git/prepare-worktree.js";
import { buildRemediationPrompt } from "../opencode/build-remediation-prompt.js";
import { buildReviewPrompt } from "../opencode/build-review-prompt.js";
import { buildTaskPrompt } from "../opencode/build-task-prompt.js";
import type { OpenCodeClient } from "../opencode/opencode-client.js";
import { parseReviewResult } from "../opencode/parse-review-result.js";
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
  console.log(`[${project.id}] Starting OpenCode implementation...`);

  const implementation = await opencode.run({
    cwd: worktree.path,
    model: project.opencode.model,
    variant: project.opencode.variant,
    prompt: buildTaskPrompt(card),
  });

  if (implementation.exitCode !== 0) {
    throw new Error(
      `OpenCode implementation exited with code ${implementation.exitCode}`,
    );
  }

  console.log(`[${project.id}] OpenCode implementation completed`);

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

  console.log(`[${project.id}] Starting fresh OpenCode review...`);

  const review = await opencode.run({
    cwd: worktree.path,
    model: project.opencode.model,
    variant: project.opencode.variant,
    prompt: buildReviewPrompt(card),
  });

  if (review.exitCode !== 0) {
    throw new Error(`OpenCode review exited with code ${review.exitCode}`);
  }

  const reviewResult = parseReviewResult(review.output);

  if (reviewResult === "pass") {
    console.log(`[${project.id}] OpenCode review passed`);
    return;
  }

  console.log(
    `[${project.id}] OpenCode review failed; starting remediation...`,
  );

  const remediation = await opencode.run({
    cwd: worktree.path,
    model: project.opencode.model,
    variant: project.opencode.variant,
    prompt: buildRemediationPrompt(card, review.output),
  });

  if (remediation.exitCode !== 0) {
    throw new Error(
      `OpenCode remediation exited with code ${remediation.exitCode}`,
    );
  }

  console.log(`[${project.id}] OpenCode remediation completed`);

  const remediatedStatus = await git.getStatus(worktree.path);

  if (remediatedStatus.length === 0) {
    throw new Error("OpenCode remediation left no repository changes");
  }

  if (project.repository.validationCommand) {
    console.log(
      `[${project.id}] Running repository validation after remediation...`,
    );

    const validation = await commands.run({
      cwd: worktree.path,
      command: project.repository.validationCommand,
    });

    if (validation.exitCode !== 0) {
      throw new Error(
        `Repository validation after remediation exited with code ${validation.exitCode}`,
      );
    }

    console.log(
      `[${project.id}] Repository validation after remediation passed`,
    );
  }

  console.log(`[${project.id}] Starting second fresh OpenCode review...`);

  const secondReview = await opencode.run({
    cwd: worktree.path,
    model: project.opencode.model,
    variant: project.opencode.variant,
    prompt: buildReviewPrompt(card),
  });

  if (secondReview.exitCode !== 0) {
    throw new Error(
      `Second OpenCode review exited with code ${secondReview.exitCode}`,
    );
  }

  const secondReviewResult = parseReviewResult(secondReview.output);

  if (secondReviewResult === "fail") {
    throw new Error("OpenCode review failed after remediation");
  }

  console.log(`[${project.id}] OpenCode review passed after remediation`);
}
