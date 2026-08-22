import type { ProjectConfig } from "../config/config.js";
import { cleanupWorktree } from "../git/cleanup-worktree.js";
import type { GitClient } from "../git/git-client.js";
import { prepareReviewWorktree } from "../git/prepare-review-worktree.js";
import { prepareWorktree } from "../git/prepare-worktree.js";
import type { GitHubClient } from "../github/github-client.js";
import { logger } from "../logging/logger.js";
import { getSessionLogPath } from "../logging/session-log.js";
import { buildCommitPrompt } from "../opencode/build-commit-prompt.js";
import { buildRemediationPrompt } from "../opencode/build-remediation-prompt.js";
import { buildReviewFeedbackPrompt } from "../opencode/build-review-feedback-prompt.js";
import { buildReviewPrompt } from "../opencode/build-review-prompt.js";
import { buildTaskPrompt } from "../opencode/build-task-prompt.js";
import {
  OpenCodeRunAbortedError,
  type OpenCodeClient,
} from "../opencode/opencode-client.js";
import { parseReviewResult } from "../opencode/parse-review-result.js";
import type { CommandRunner } from "../process/command-runner.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";

import { claimNextCard } from "./claim-next-card.js";
import { failCard } from "./fail-card.js";
import { publishCard } from "./publish-card.js";
import {
  reconcileReviewCards,
  type ReviewChangeRequest,
} from "./reconcile-review-cards.js";
import {
  reconcileClaimedCard,
  reconcileWorkingCards,
} from "./reconcile-working-cards.js";
import { WorkflowError } from "./workflow-error.js";

function isWorkflowAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && error instanceof OpenCodeRunAbortedError;
}

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
    await processReviewChangeRequest(
      trello,
      git,
      github,
      opencode,
      commands,
      project,
      reviewChangeRequest,
      signal,
    );

    return;
  }

  const workingChangeRequest = await reconcileWorkingCards(
    trello,
    git,
    github,
    project,
  );

  if (workingChangeRequest) {
    await processReviewChangeRequest(
      trello,
      git,
      github,
      opencode,
      commands,
      project,
      workingChangeRequest,
      signal,
    );

    return;
  }

  const card = await claimNextCard(trello, project);

  if (!card) {
    logger.child({ projectId: project.id }).debug("No cards ready");
    return;
  }

  logger
    .child({
      projectId: project.id,
      cardId: card.id,
    })
    .event(`Claimed card: ${card.name}`);

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
    if (isWorkflowAbort(error, signal)) {
      console.log(
        `[${project.id}] Card workflow interrupted by orchestrator shutdown`,
      );
      return;
    }

    console.error(`[${project.id}] Card workflow failed; moving to Failed...`);

    await failCard(trello, project, card.id, error);
  }
}

async function processReviewChangeRequest(
  trello: TrelloClient,
  git: GitClient,
  github: GitHubClient,
  opencode: OpenCodeClient,
  commands: CommandRunner,
  project: ProjectConfig,
  reviewChangeRequest: ReviewChangeRequest,
  signal: AbortSignal,
): Promise<void> {
  const card = reviewChangeRequest.card;

  console.log(`[${project.id}] Processing requested changes for: ${card.name}`);

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
    if (isWorkflowAbort(error, signal)) {
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

  const sessionLogPath = getSessionLogPath(project.id, card.id);

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
    sessionLogPath,
    sessionLabel: `OpenCode ${implementationLabel}`,
  });

  if (implementation.exitCode !== 0) {
    throw new WorkflowError(
      "OpenCode",
      `OpenCode ${implementationLabel} exited with code ${implementation.exitCode}`,
    );
  }

  console.log(`[${project.id}] OpenCode ${implementationLabel} completed`);

  const status = await git.getStatus(worktree.path);

  if (status.length === 0) {
    throw new WorkflowError(
      "OpenCode",
      "OpenCode completed without repository changes",
    );
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
      sessionLogPath,
      sessionLabel: "Repository validation",
    });

    if (validation.exitCode !== 0) {
      throw new WorkflowError(
        "Validation",
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
    sessionLogPath,
    sessionLabel: "OpenCode review",
  });

  if (review.exitCode !== 0) {
    throw new WorkflowError(
      "OpenCode",
      `OpenCode review exited with code ${review.exitCode}`,
    );
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
      sessionLogPath,
      sessionLabel: "OpenCode remediation",
    });

    if (remediation.exitCode !== 0) {
      throw new WorkflowError(
        "OpenCode",
        `OpenCode remediation exited with code ${remediation.exitCode}`,
      );
    }

    console.log(`[${project.id}] OpenCode remediation completed`);

    const remediatedStatus = await git.getStatus(worktree.path);

    if (remediatedStatus.length === 0) {
      throw new WorkflowError(
        "OpenCode",
        "OpenCode remediation left no repository changes",
      );
    }

    if (project.repository.validationCommand) {
      console.log(
        `[${project.id}] Running repository validation after remediation...`,
      );

      const validation = await commands.run({
        cwd: worktree.path,
        command: project.repository.validationCommand,
        sessionLogPath,
        sessionLabel: "Repository validation after remediation",
      });

      if (validation.exitCode !== 0) {
        throw new WorkflowError(
          "Validation",
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
      sessionLogPath,
      sessionLabel: "OpenCode second review",
    });

    if (secondReview.exitCode !== 0) {
      throw new WorkflowError(
        "OpenCode",
        `Second OpenCode review exited with code ${secondReview.exitCode}`,
      );
    }

    const secondReviewResult = parseReviewResult(secondReview.output);

    if (secondReviewResult === "fail") {
      throw new WorkflowError(
        "OpenCode",
        "OpenCode review failed after remediation",
      );
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
    sessionLogPath,
    sessionLabel: "OpenCode commit",
  });

  if (commit.exitCode !== 0) {
    throw new WorkflowError(
      "OpenCode",
      `OpenCode commit exited with code ${commit.exitCode}`,
    );
  }

  const headAfterCommit = await git.getHeadSha(worktree.path);

  if (headAfterCommit === headBeforeCommit) {
    throw new WorkflowError(
      "OpenCode",
      "OpenCode commit session did not create a commit",
    );
  }

  const statusAfterCommit = await git.getStatus(worktree.path);

  if (statusAfterCommit.length > 0) {
    throw new WorkflowError(
      "OpenCode",
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
