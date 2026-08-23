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
  type OpenCodeRunResult,
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

function hasOpenCodePermissionDenial(result: OpenCodeRunResult): boolean {
  const output = `${result.output}\n${result.errorOutput}`.toLowerCase();

  return (
    output.includes("auto-rejecting") ||
    output.includes("rejected permission") ||
    output.includes("permission denied")
  );
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

  const cardLog = logger.child({
    projectId: project.id,
    cardId: card.id,
  });

  cardLog.event(`Claimed card: ${card.name}`);

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

    cardLog.info("Cleaning up published worktree...");

    try {
      await cleanupWorktree({
        git,
        project,
        worktreePath: worktree.path,
        branch: worktree.branch,
      });

      cardLog.info("Published worktree cleaned up");
    } catch (cleanupError) {
      cardLog.error(
        `Published successfully, but local cleanup failed: ${
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError)
        }`,
      );
    }
  } catch (error) {
    if (isWorkflowAbort(error, signal)) {
      cardLog.event("Card workflow interrupted by orchestrator shutdown");
      return;
    }

    cardLog.error("Card workflow failed; moving to Failed...");

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

  const cardLog = logger.child({
    projectId: project.id,
    cardId: card.id,
  });

  cardLog.event(`Processing requested changes for: ${card.name}`);

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

    cardLog.info("Cleaning up review feedback worktree...");

    try {
      await cleanupWorktree({
        git,
        project,
        worktreePath: worktree.path,
        branch: worktree.branch,
      });

      cardLog.info("Review feedback worktree cleaned up");
    } catch (cleanupError) {
      cardLog.error(
        `Review feedback published successfully, but local cleanup failed: ${
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError)
        }`,
      );
    }
  } catch (error) {
    if (isWorkflowAbort(error, signal)) {
      cardLog.event(
        "Review change workflow interrupted by orchestrator shutdown",
      );

      return;
    }

    cardLog.error("Review change workflow failed; moving to Failed...");

    await failCard(trello, project, card.id, error);
  }
}

interface ReviewIterationOptions {
  pullRequestUrl: string;
  feedback: string;
}

const MAX_REMEDIATION_PASSES = 2;

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
  let remediationPasses = 0;
  let previousFindings: string | undefined;

  const sessionLogPath = getSessionLogPath(project.id, card.id);

  const cardLog = logger.child({
    projectId: project.id,
    cardId: card.id,
  });

  cardLog.info(`Branch: ${worktree.branch}`);
  cardLog.info(`Worktree: ${worktree.path}`);

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

  cardLog.event(`Starting OpenCode ${implementationLabel}...`);

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
    if (hasOpenCodePermissionDenial(implementation)) {
      throw new WorkflowError(
        "OpenCode permissions",
        `OpenCode was denied permission during ${implementationLabel}`,
      );
    }

    throw new WorkflowError(
      "OpenCode",
      `OpenCode ${implementationLabel} exited with code ${implementation.exitCode}`,
    );
  }

  cardLog.event(`OpenCode ${implementationLabel} completed`);

  const status = await git.getStatus(worktree.path);

  if (status.length === 0) {
    throw new WorkflowError(
      "OpenCode",
      "OpenCode completed without repository changes",
    );
  }

  cardLog.info("Repository changes detected:");

  for (const line of status.split("\n")) {
    cardLog.info(line);
  }

  if (project.repository.validationCommand) {
    cardLog.event("Running repository validation...");

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

    cardLog.event("Repository validation passed");
  }

  while (true) {
    const reviewNumber = remediationPasses + 1;

    cardLog.event(`Starting fresh OpenCode review #${reviewNumber}...`);

    const review = await opencode.run({
      cwd: worktree.path,
      model: project.opencode.model,
      variant: project.opencode.variant,
      timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
      prompt: buildReviewPrompt(card, previousFindings),
      signal,
      sessionLogPath,
      sessionLabel: `OpenCode review #${reviewNumber}`,
    });

    if (review.exitCode !== 0) {
      throw new WorkflowError(
        "OpenCode",
        `OpenCode review #${reviewNumber} exited with code ${review.exitCode}`,
      );
    }

    const parsedReviewResult = parseReviewResult(review.output);

    if (parsedReviewResult === "pass") {
      cardLog.event(`OpenCode review #${reviewNumber} passed`);
      break;
    }

    if (remediationPasses >= MAX_REMEDIATION_PASSES) {
      cardLog.event(
        `OpenCode review #${reviewNumber} failed; remediation limit reached`,
      );

      throw new WorkflowError(
        "OpenCode",
        `OpenCode review failed after ${remediationPasses} remediation passes`,
      );
    }

    const remediationNumber = remediationPasses + 1;

    previousFindings = review.output;

    cardLog.event(
      `OpenCode review #${reviewNumber} failed; starting remediation #${remediationNumber}...`,
    );

    const remediation = await opencode.run({
      cwd: worktree.path,
      model: project.opencode.model,
      variant: project.opencode.variant,
      timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
      prompt: buildRemediationPrompt(card, review.output),
      signal,
      sessionLogPath,
      sessionLabel: `OpenCode remediation #${remediationNumber}`,
    });

    if (remediation.exitCode !== 0) {
      throw new WorkflowError(
        "OpenCode",
        `OpenCode remediation #${remediationNumber} exited with code ${remediation.exitCode}`,
      );
    }

    cardLog.event(`OpenCode remediation #${remediationNumber} completed`);

    const remediatedStatus = await git.getStatus(worktree.path);

    if (remediatedStatus.length === 0) {
      throw new WorkflowError(
        "OpenCode",
        `OpenCode remediation #${remediationNumber} left no repository changes`,
      );
    }

    if (project.repository.validationCommand) {
      cardLog.event(
        `Running repository validation after remediation #${remediationNumber}...`,
      );

      const validation = await commands.run({
        cwd: worktree.path,
        command: project.repository.validationCommand,
        sessionLogPath,
        sessionLabel: `Repository validation after remediation #${remediationNumber}`,
      });

      if (validation.exitCode !== 0) {
        throw new WorkflowError(
          "Validation",
          `Repository validation after remediation #${remediationNumber} exited with code ${validation.exitCode}`,
        );
      }

      validationResult = `Passed after remediation #${remediationNumber}`;

      cardLog.event(
        `Repository validation after remediation #${remediationNumber} passed`,
      );
    }

    remediationPasses += 1;
  }

  const remediationPassLabel =
    remediationPasses === 1 ? "remediation pass" : "remediation passes";

  const reviewResult =
    remediationPasses === 0
      ? "Passed"
      : `Passed after ${remediationPasses} ${remediationPassLabel}`;

  const remediationResult =
    remediationPasses === 0
      ? "Not required"
      : `${remediationPasses} ${remediationPassLabel} applied`;

  const headBeforeCommit = await git.getHeadSha(worktree.path);

  cardLog.event("Starting fresh OpenCode commit session...");

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

  cardLog.event(`OpenCode commit created: ${headAfterCommit}`);

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
