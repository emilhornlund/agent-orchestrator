import type { ProjectConfig } from "../config/config.js";
import { cleanupWorktree } from "../git/cleanup-worktree.js";
import type { GitClient } from "../git/git-client.js";
import { prepareReviewWorktree } from "../git/prepare-review-worktree.js";
import { prepareWorktree } from "../git/prepare-worktree.js";
import type { GitHubClient } from "../github/github-client.js";
import { buildCommitPrompt } from "../opencode/build-commit-prompt.js";
import { buildRemediationPrompt } from "../opencode/build-remediation-prompt.js";
import { buildReviewFeedbackPrompt } from "../opencode/build-review-feedback-prompt.js";
import { buildReviewPrompt } from "../opencode/build-review-prompt.js";
import { buildTaskPrompt } from "../opencode/build-task-prompt.js";
import type { OpenCodeClient } from "../opencode/opencode-client.js";
import { parseReviewResult } from "../opencode/parse-review-result.js";
import type { CommandRunner } from "../process/command-runner.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";

import { claimNextCard } from "./claim-next-card.js";
import { failCard } from "./fail-card.js";
import { publishCard } from "./publish-card.js";
import { reconcileReviewCards } from "./reconcile-review-cards.js";
import {
  reconcileClaimedCard,
  reconcileWorkingCards,
} from "./reconcile-working-cards.js";

export async function pollProject(
  trello: TrelloClient,
  git: GitClient,
  github: GitHubClient,
  opencode: OpenCodeClient,
  commands: CommandRunner,
  project: ProjectConfig,
  signal: AbortSignal,
): Promise<void> {
  const reviewChangeRequest = await reconcileReviewCards(
    trello,
    git,
    github,
    project,
  );

  if (reviewChangeRequest) {
    const card = reviewChangeRequest.card;

    console.log(
      `[${project.id}] Processing requested changes for: ${card.name}`,
    );

    try {
      const worktree = await processCardChanges(
        trello,
        git,
        github,
        opencode,
        commands,
        project,
        card,
        signal,
        {
          pullRequestUrl: reviewChangeRequest.pullRequestUrl,
          feedback: reviewChangeRequest.feedback,
        },
      );

      console.log(`[${project.id}] Cleaning up review feedback worktree...`);

      try {
        await cleanupWorktree({
          git,
          project,
          worktreePath: worktree.path,
          branch: worktree.branch,
        });

        console.log(`[${project.id}] Review feedback worktree cleaned up`);
      } catch (cleanupError) {
        console.error(
          `[${project.id}] Review feedback published successfully, but local cleanup failed: ${
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError)
          }`,
        );
      }
    } catch (error) {
      if (signal.aborted) {
        console.log(
          `[${project.id}] Review change workflow interrupted by orchestrator shutdown`,
        );

        return;
      }

      console.error(
        `[${project.id}] Review change workflow failed; moving to Failed...`,
      );

      await failCard(trello, project, card.id, error);
    }

    return;
  }

  await reconcileWorkingCards(trello, git, github, project);

  const card = await claimNextCard(trello, project);

  if (!card) {
    console.log(`[${project.id}] No cards ready`);
    return;
  }

  console.log(`[${project.id}] Claimed card: ${card.name}`);

  try {
    const reconciled = await reconcileClaimedCard(
      trello,
      git,
      github,
      project,
      card,
    );

    if (reconciled) {
      return;
    }

    const worktree = await processCardChanges(
      trello,
      git,
      github,
      opencode,
      commands,
      project,
      card,
      signal,
    );

    console.log(`[${project.id}] Cleaning up published worktree...`);

    try {
      await cleanupWorktree({
        git,
        project,
        worktreePath: worktree.path,
        branch: worktree.branch,
      });

      console.log(`[${project.id}] Published worktree cleaned up`);
    } catch (cleanupError) {
      console.error(
        `[${project.id}] Published successfully, but local cleanup failed: ${
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError)
        }`,
      );
    }
  } catch (error) {
    if (signal.aborted) {
      console.log(
        `[${project.id}] Card workflow interrupted by orchestrator shutdown`,
      );
      return;
    }

    console.error(`[${project.id}] Card workflow failed; moving to Failed...`);

    await failCard(trello, project, card.id, error);
  }
}

interface ReviewIterationOptions {
  pullRequestUrl: string;
  feedback: string;
}

async function processCardChanges(
  trello: TrelloClient,
  git: GitClient,
  github: GitHubClient,
  opencode: OpenCodeClient,
  commands: CommandRunner,
  project: ProjectConfig,
  card: TrelloCard,
  signal: AbortSignal,
  reviewIteration?: ReviewIterationOptions,
): Promise<{
  path: string;
  branch: string;
}> {
  const worktree = reviewIteration
    ? await prepareReviewWorktree(git, project, card.id)
    : await prepareWorktree(git, project, card.id);

  let validationResult = "Not configured";
  let reviewResult: string;
  let remediationResult: string;

  console.log(`[${project.id}] Branch: ${worktree.branch}`);
  console.log(`[${project.id}] Worktree: ${worktree.path}`);
  const implementationLabel = reviewIteration
    ? "review feedback implementation"
    : "implementation";

  const implementationPrompt = reviewIteration
    ? buildReviewFeedbackPrompt(
        card,
        reviewIteration.pullRequestUrl,
        reviewIteration.feedback,
      )
    : buildTaskPrompt(card);

  console.log(`[${project.id}] Starting OpenCode ${implementationLabel}...`);

  const implementation = await opencode.run({
    cwd: worktree.path,
    model: project.opencode.model,
    variant: project.opencode.variant,
    timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
    prompt: implementationPrompt,
    signal,
  });

  if (implementation.exitCode !== 0) {
    throw new Error(
      `OpenCode ${implementationLabel} exited with code ${implementation.exitCode}`,
    );
  }

  console.log(`[${project.id}] OpenCode ${implementationLabel} completed`);

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

    validationResult = "Passed";

    console.log(`[${project.id}] Repository validation passed`);
  }

  console.log(`[${project.id}] Starting fresh OpenCode review...`);

  const review = await opencode.run({
    cwd: worktree.path,
    model: project.opencode.model,
    variant: project.opencode.variant,
    timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
    prompt: buildReviewPrompt(card),
    signal,
  });

  if (review.exitCode !== 0) {
    throw new Error(`OpenCode review exited with code ${review.exitCode}`);
  }

  const parsedReviewResult = parseReviewResult(review.output);

  if (parsedReviewResult === "pass") {
    reviewResult = "Passed";
    remediationResult = "Not required";

    console.log(`[${project.id}] OpenCode review passed`);
  } else {
    remediationResult = "Applied after initial review failure";

    console.log(
      `[${project.id}] OpenCode review failed; starting remediation...`,
    );

    const remediation = await opencode.run({
      cwd: worktree.path,
      model: project.opencode.model,
      variant: project.opencode.variant,
      timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
      prompt: buildRemediationPrompt(card, review.output),
      signal,
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

      validationResult = "Passed after remediation";

      console.log(
        `[${project.id}] Repository validation after remediation passed`,
      );
    }

    console.log(`[${project.id}] Starting second fresh OpenCode review...`);

    const secondReview = await opencode.run({
      cwd: worktree.path,
      model: project.opencode.model,
      variant: project.opencode.variant,
      timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
      prompt: buildReviewPrompt(card),
      signal,
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

    reviewResult = "Passed after remediation";

    console.log(`[${project.id}] OpenCode review passed after remediation`);
  }

  const headBeforeCommit = await git.getHeadSha(worktree.path);

  console.log(`[${project.id}] Starting fresh OpenCode commit session...`);

  const commit = await opencode.run({
    cwd: worktree.path,
    model: project.opencode.model,
    variant: project.opencode.variant,
    timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
    prompt: buildCommitPrompt(card),
    signal,
  });

  if (commit.exitCode !== 0) {
    throw new Error(`OpenCode commit exited with code ${commit.exitCode}`);
  }

  const headAfterCommit = await git.getHeadSha(worktree.path);

  if (headAfterCommit === headBeforeCommit) {
    throw new Error("OpenCode commit session did not create a commit");
  }

  const statusAfterCommit = await git.getStatus(worktree.path);

  if (statusAfterCommit.length > 0) {
    throw new Error(
      `OpenCode commit left repository changes:\n${statusAfterCommit}`,
    );
  }

  console.log(`[${project.id}] OpenCode commit created: ${headAfterCommit}`);

  await publishCard({
    trello,
    git,
    github,
    project,
    card,
    worktreePath: worktree.path,
    branch: worktree.branch,
    commitSha: headAfterCommit,
    validationResult,
    reviewResult,
    remediationResult,
  });

  return worktree;
}
