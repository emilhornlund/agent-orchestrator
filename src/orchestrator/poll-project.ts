import type { ProjectConfig } from "../config/config.js";
import { type CardAttachmentPromptContext } from "../context/card-attachment-prompt.js";
import {
  materializeCardAttachments,
  type CardAttachmentManifest,
} from "../context/materialize-card-attachments.js";
import { hasCommittedImplementation } from "../git/detect-committed-implementation.js";
import { cleanupWorktree } from "../git/cleanup-worktree.js";
import {
  getGitIdentityEnvironment,
  type GitClient,
} from "../git/git-client.js";
import { prepareReviewWorktree } from "../git/prepare-review-worktree.js";
import {
  prepareWorktree,
  type PreparedImplementationWorktree,
} from "../git/prepare-worktree.js";
import type { GitHubClient } from "../github/github-client.js";
import { logger } from "../logging/logger.js";
import { getSessionLogPath } from "../logging/session-log.js";
import {
  notifyRefinementCompletion,
  type EmailNotifier,
} from "../notifications/email-notifier.js";
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
import {
  CommandRunAbortedError,
  type CommandRunner,
  type CommandRunResult,
} from "../process/command-runner.js";
import { clearRefinementResult } from "../refinement/refinement-result.js";
import { finalizeRefinement } from "../refinement/finalize-refinement.js";
import { addRefinementCompletionComment } from "../refinement/refinement-completion.js";
import { runRefinement } from "../refinement/run-refinement.js";
import {
  TrelloRequestAbortedError,
  type TrelloCard,
  type TrelloClient,
} from "../trello/trello-client.js";

import { claimNextCard } from "./claim-next-card.js";
import { claimNextRefinementCard } from "./claim-next-refinement-card.js";
import {
  annotateFailure,
  formatFailureDiagnostic,
  getExistingSessionLogPath,
  toFailureError,
} from "./failure-diagnostic.js";
import { failCard } from "./fail-card.js";
import { publishCard } from "./publish-card.js";
import { PublishedCardStateError } from "./published-card-state-error.js";
import {
  reconcileReviewCards,
  type ReviewChangeRequest,
} from "./reconcile-review-cards.js";
import {
  reconcileClaimedCard,
  isImplementationWorkingCard,
  reconcileWorkingCards,
} from "./reconcile-working-cards.js";
import { WorkflowError } from "./workflow-error.js";
import { getElapsedRefinementWorkflowTime } from "./workflow-duration.js";

export type PollingProject = ProjectConfig & {
  contextRoot?: string;
  maxAttachmentBytes?: number;
  maxTotalAttachmentBytes?: number;
};

function isWorkflowAbort(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) {
    return false;
  }

  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current !== undefined && !seen.has(current)) {
    seen.add(current);

    if (
      current instanceof OpenCodeRunAbortedError ||
      current instanceof CommandRunAbortedError ||
      current instanceof TrelloRequestAbortedError
    ) {
      return true;
    }

    current = current instanceof Error ? current.cause : undefined;
  }

  return false;
}

function hasOpenCodePermissionDenial(result: OpenCodeRunResult): boolean {
  const output = `${result.output}\n${result.errorOutput}`.toLowerCase();

  return (
    output.includes("auto-rejecting") ||
    output.includes("rejected permission") ||
    output.includes("permission denied")
  );
}

async function runSetup(
  commands: CommandRunner,
  cwd: string,
  command: string,
  timeoutMilliseconds: number,
  signal: AbortSignal,
  sessionLogPath: string,
  sessionLabel: string,
): Promise<CommandRunResult> {
  try {
    return await commands.run({
      cwd,
      command,
      timeoutMilliseconds,
      signal,
      sessionLogPath,
      sessionLabel,
    });
  } catch (error) {
    if (error instanceof CommandRunAbortedError) {
      throw error;
    }

    const setupError = toFailureError(error);

    throw new WorkflowError("Setup", setupError.message, { cause: error });
  }
}

async function detectReusableImplementation(
  git: GitClient,
  project: ProjectConfig,
  worktreePath: string,
  initialStatus?: string,
): Promise<boolean> {
  try {
    return await hasCommittedImplementation(
      git,
      worktreePath,
      `origin/${project.repository.defaultBranch}`,
      initialStatus,
    );
  } catch (error) {
    const stateError = toFailureError(error);

    throw new WorkflowError(
      "Git/GitHub",
      `Could not safely inspect existing task branch: ${stateError.message}`,
      { cause: error },
    );
  }
}

export async function pollProject(
  trello: TrelloClient,
  git: GitClient,
  github: GitHubClient,
  opencode: OpenCodeClient,
  commands: CommandRunner,
  project: PollingProject,
  signal: AbortSignal,
  emailNotifier?: EmailNotifier,
): Promise<void> {
  if (signal.aborted) {
    return;
  }

  const workingChangeRequest = await reconcileWorkingCards(
    trello,
    git,
    github,
    project,
    emailNotifier,
    signal,
  );

  if (signal.aborted) {
    return;
  }

  const reviewChangeRequest = await reconcileReviewCards(
    trello,
    git,
    github,
    project,
    { moveRequestedChanges: workingChangeRequest === null },
    emailNotifier,
    signal,
  );

  if (signal.aborted) {
    return;
  }

  if (reviewChangeRequest && workingChangeRequest) {
    const conflictingWorkflowError = new WorkflowError(
      "Workflow",
      `Cannot process workflow cards in both Human Review (${reviewChangeRequest.card.id}) and Working (${workingChangeRequest.card.id})`,
    );

    annotateFailure(conflictingWorkflowError, {
      projectId: project.id,
      cardIds: [reviewChangeRequest.card.id, workingChangeRequest.card.id],
      sessionLogPaths: [
        reviewChangeRequest.card.id,
        workingChangeRequest.card.id,
      ]
        .map((cardId) => getExistingSessionLogPath(project.id, cardId))
        .filter(
          (sessionLogPath): sessionLogPath is string =>
            sessionLogPath !== undefined,
        ),
    });

    throw conflictingWorkflowError;
  }

  if (reviewChangeRequest && "active" in reviewChangeRequest) {
    return;
  }

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
      emailNotifier,
    );

    return;
  }

  if (workingChangeRequest) {
    if (isImplementationWorkingCard(workingChangeRequest)) {
      if (workingChangeRequest.workflow === "refinement") {
        await processRefinementCard(
          trello,
          git,
          opencode,
          project,
          workingChangeRequest.card,
          signal,
          undefined,
          emailNotifier,
        );
      } else {
        await processImplementationCard(
          trello,
          git,
          github,
          opencode,
          commands,
          project,
          workingChangeRequest.card,
          signal,
          undefined,
          emailNotifier,
        );
      }

      return;
    }

    await processReviewChangeRequest(
      trello,
      git,
      github,
      opencode,
      commands,
      project,
      workingChangeRequest,
      signal,
      emailNotifier,
    );

    return;
  }

  const refinementClaim = await claimNextRefinementCard(
    trello,
    git,
    project,
    signal,
  );

  if (refinementClaim) {
    if (signal.aborted) {
      return;
    }

    await processRefinementCard(
      trello,
      git,
      opencode,
      project,
      refinementClaim.card,
      signal,
      refinementClaim.worktree,
      emailNotifier,
    );

    return;
  }

  const implementationClaim = await claimNextCard(trello, git, project, signal);

  if (!implementationClaim) {
    return;
  }

  if (signal.aborted) {
    return;
  }

  const card = implementationClaim.card;
  const cardLog = logger.child({
    projectId: project.id,
    cardId: card.id,
  });

  cardLog.event(`Claimed card: ${card.name}`);

  const reconciled = await reconcileClaimedCard(
    trello,
    git,
    github,
    project,
    card,
    emailNotifier,
    signal,
  );

  if (reconciled) {
    return;
  }

  if (signal.aborted) {
    return;
  }

  await processImplementationCard(
    trello,
    git,
    github,
    opencode,
    commands,
    project,
    card,
    signal,
    implementationClaim.worktree,
    emailNotifier,
  );
}

async function processRefinementCard(
  trello: TrelloClient,
  git: GitClient,
  opencode: OpenCodeClient,
  project: PollingProject,
  card: TrelloCard,
  signal: AbortSignal,
  preparedWorktree?: {
    path: string;
    branch: string;
  },
  emailNotifier?: EmailNotifier,
): Promise<void> {
  const cardLog = logger.child({
    projectId: project.id,
    cardId: card.id,
  });

  cardLog.event(`Claimed refinement card: ${card.name}`);

  let worktree:
    | {
        path: string;
        branch: string;
      }
    | undefined;
  let cardContextPreparationFailed = false;

  try {
    worktree =
      preparedWorktree ?? (await prepareWorktree(git, project, card.id));

    cardLog.info(`Branch: ${worktree.branch}`);
    cardLog.info(`Worktree: ${worktree.path}`);

    cardContextPreparationFailed = true;
    const attachmentManifest = await prepareCardContext(
      trello,
      project,
      card,
      signal,
    );
    cardContextPreparationFailed = false;
    const attachmentContext = createCardAttachmentPromptContext(
      project,
      card,
      attachmentManifest,
    );

    cardLog.event("Starting OpenCode refinement...");

    const result = await runRefinement(
      git,
      opencode,
      project,
      card,
      worktree.path,
      signal,
      attachmentContext,
    );

    cardLog.event(
      `OpenCode refinement completed with classification: ${result.type}`,
    );

    await finalizeRefinement(trello, project, card, result, signal);

    cardLog.event("Refined card returned to Backlog");

    const elapsedWorkflowTime = await getElapsedRefinementWorkflowTime(
      trello,
      project,
      card.id,
      cardLog,
    );

    await notifyRefinementCompletion(
      emailNotifier,
      {
        project,
        card,
        result,
      },
      cardLog,
    );

    await addRefinementCompletionComment(
      trello,
      card,
      result,
      cardLog,
      elapsedWorkflowTime,
    );

    if (signal.aborted) {
      return;
    }

    clearRefinementResult(worktree.path);

    cardLog.info("Cleaning up refinement worktree...");

    await cleanupWorktree({
      git,
      project,
      worktreePath: worktree.path,
      branch: worktree.branch,
      signal,
    });

    if (signal.aborted) {
      return;
    }

    cardLog.info("Refinement worktree cleaned up");
  } catch (error) {
    if (isWorkflowAbort(error, signal)) {
      cardLog.event("Refinement workflow interrupted by orchestrator shutdown");
      return;
    }

    if (worktree && !cardContextPreparationFailed) {
      cardLog.info("Resetting failed refinement worktree...");

      try {
        clearRefinementResult(worktree.path);
        await git.resetHard(worktree.path);
        await git.cleanUntracked(worktree.path);

        cardLog.info("Failed refinement worktree reset");
      } catch (cleanupError) {
        cardLog.error(
          `Failed to reset refinement worktree: ${
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError)
          }`,
        );
      }
    }

    await failCard(trello, project, card.id, error, emailNotifier, card);
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
  emailNotifier?: EmailNotifier,
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
      undefined,
      emailNotifier,
    );

    if (signal.aborted) {
      cardLog.event("Review change workflow stopped before worktree cleanup");
      return;
    }

    cardLog.info("Cleaning up review feedback worktree...");

    try {
      await cleanupWorktree({
        git,
        project,
        worktreePath: worktree.path,
        branch: worktree.branch,
        signal,
      });

      if (signal.aborted) {
        return;
      }

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

    await failCard(trello, project, card.id, error, emailNotifier, card);
  }
}

async function processImplementationCard(
  trello: TrelloClient,
  git: GitClient,
  github: GitHubClient,
  opencode: OpenCodeClient,
  commands: CommandRunner,
  project: PollingProject,
  card: TrelloCard,
  signal: AbortSignal,
  preparedWorktree?: PreparedImplementationWorktree,
  emailNotifier?: EmailNotifier,
): Promise<void> {
  const cardLog = logger.child({
    projectId: project.id,
    cardId: card.id,
  });

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
      undefined,
      preparedWorktree,
      emailNotifier,
    );

    if (signal.aborted) {
      cardLog.event("Card workflow stopped before worktree cleanup");
      return;
    }

    cardLog.info("Cleaning up published worktree...");

    try {
      await cleanupWorktree({
        git,
        project,
        worktreePath: worktree.path,
        branch: worktree.branch,
        signal,
      });

      if (signal.aborted) {
        return;
      }

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

    if (error instanceof PublishedCardStateError) {
      const sessionLogPath = getExistingSessionLogPath(project.id, card.id);

      cardLog.error(
        formatFailureDiagnostic(error, {
          ...(sessionLogPath === undefined ? {} : { sessionLogPath }),
          handlingOutcome: "card left in Working for reconciliation",
        }),
      );
      return;
    }

    await failCard(trello, project, card.id, error, emailNotifier, card);
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
  project: PollingProject,
  card: TrelloCard,
  signal: AbortSignal,
  reviewIteration?: ReviewIterationOptions,
  preparedWorktree?: PreparedImplementationWorktree,
  emailNotifier?: EmailNotifier,
): Promise<{
  path: string;
  branch: string;
}> {
  const worktree = reviewIteration
    ? await prepareReviewWorktree(git, project, card.id)
    : (preparedWorktree ?? (await prepareWorktree(git, project, card.id)));

  let reviewResult = "Passed";
  let remediationResult = "Not required";

  const sessionLogPath = getSessionLogPath(project.id, card.id);

  const cardLog = logger.child({
    projectId: project.id,
    cardId: card.id,
  });

  cardLog.info(`Branch: ${worktree.branch}`);
  cardLog.info(`Worktree: ${worktree.path}`);

  const implementationWorktree = reviewIteration
    ? undefined
    : (worktree as PreparedImplementationWorktree);

  if (
    implementationWorktree?.reused &&
    (await detectReusableImplementation(
      git,
      project,
      worktree.path,
      implementationWorktree.initialStatus,
    ))
  ) {
    const commitSha = await git.getHeadSha(worktree.path);

    cardLog.event(
      `Reusing committed implementation ${commitSha}; skipping implementation stages`,
    );

    await publishCard({
      trello,
      git,
      github,
      project,
      card,
      worktreePath: worktree.path,
      branch: worktree.branch,
      commitSha,
      reviewResult,
      remediationResult,
      signal,
      ...(emailNotifier === undefined ? {} : { emailNotifier }),
    });

    return worktree;
  }

  if (project.repository.setupCommand) {
    cardLog.event("Running repository setup...");

    const setup = await runSetup(
      commands,
      worktree.path,
      project.repository.setupCommand,
      project.opencode.timeoutMinutes * 60_000,
      signal,
      sessionLogPath,
      "Repository setup",
    );

    if (setup.exitCode !== 0) {
      throw new WorkflowError(
        "Setup",
        `Repository setup exited with code ${setup.exitCode}`,
      );
    }

    cardLog.event("Repository setup passed");
  }

  const attachmentManifest = await prepareCardContext(
    trello,
    project,
    card,
    signal,
  );
  const attachmentContext = createCardAttachmentPromptContext(
    project,
    card,
    attachmentManifest,
  );

  const implementationLabel = reviewIteration
    ? "review feedback implementation"
    : "implementation";

  const implementationPrompt = reviewIteration
    ? buildReviewFeedbackPrompt(
        card,
        reviewIteration.pullRequestUrl,
        reviewIteration.feedback,
        project.repository.validationCommand,
        attachmentContext,
      )
    : buildTaskPrompt(
        card,
        project.repository.validationCommand,
        attachmentContext,
      );

  cardLog.event(`Starting OpenCode ${implementationLabel}...`);

  const implementation = await opencode.run({
    cwd: worktree.path,
    model: project.opencode.implementation.model,
    variant: project.opencode.implementation.variant,
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

  async function runReview(): Promise<{
    output: string;
    result: ReturnType<typeof parseReviewResult>;
  }> {
    cardLog.event("Starting OpenCode review...");

    const review = await opencode.run({
      cwd: worktree.path,
      model: project.opencode.review.model,
      variant: project.opencode.review.variant,
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

    return {
      output: review.output,
      result: parseReviewResult(review.output),
    };
  }

  let { output: reviewOutput, result: parsedReviewResult } = await runReview();
  const maxRemediationPasses = project.opencode.remediation.maxPasses;
  let remediationPasses = 0;

  if (parsedReviewResult === "pass") {
    cardLog.event("OpenCode review passed");
  } else {
    reviewResult = "Findings reported";

    while (remediationPasses < maxRemediationPasses) {
      remediationPasses += 1;
      remediationResult = "Applied";

      cardLog.event(
        `Starting remediation pass ${remediationPasses} of ${maxRemediationPasses}`,
      );

      const remediationManifest = await prepareCardContext(
        trello,
        project,
        card,
        signal,
      );
      const remediationAttachmentContext = createCardAttachmentPromptContext(
        project,
        card,
        remediationManifest,
      );

      const remediation = await opencode.run({
        cwd: worktree.path,
        model: project.opencode.remediation.model,
        variant: project.opencode.remediation.variant,
        timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
        prompt: buildRemediationPrompt(
          card,
          reviewOutput,
          project.repository.validationCommand,
          remediationAttachmentContext,
        ),
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

      cardLog.event("OpenCode remediation completed");

      const remediatedStatus = await git.getStatus(worktree.path);

      if (remediatedStatus.length === 0) {
        throw new WorkflowError(
          "OpenCode",
          "OpenCode remediation left no repository changes",
        );
      }

      if (remediationPasses >= maxRemediationPasses) {
        cardLog.event(
          `Remediation pass ${remediationPasses} of ${maxRemediationPasses} reached; skipping follow-up review`,
        );
        break;
      }

      ({ output: reviewOutput, result: parsedReviewResult } =
        await runReview());

      if (parsedReviewResult === "pass") {
        cardLog.event("OpenCode review passed");
        break;
      }

      reviewResult = "Findings reported";
    }

    if (parsedReviewResult === "fail") {
      cardLog.event(
        maxRemediationPasses === 0
          ? "OpenCode review reported findings; automatic remediation is disabled"
          : `OpenCode review still reports findings after ${maxRemediationPasses} remediation pass(es); continuing to commit and publish`,
      );
    }
  }

  const headBeforeCommit = await git.getHeadSha(worktree.path);

  cardLog.event("Starting fresh OpenCode commit session...");

  const commit = await opencode.run({
    cwd: worktree.path,
    model: project.opencode.commit.model,
    variant: project.opencode.commit.variant,
    timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
    prompt: buildCommitPrompt(card),
    signal,
    environment: getGitIdentityEnvironment(project.repository.gitIdentity),
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
    reviewResult,
    remediationResult,
    signal,
    ...(emailNotifier === undefined ? {} : { emailNotifier }),
  });

  return worktree;
}

async function prepareCardContext(
  trello: TrelloClient,
  project: PollingProject,
  card: TrelloCard,
  signal: AbortSignal,
): Promise<CardAttachmentManifest | undefined> {
  if (project.contextRoot === undefined) {
    return undefined;
  }

  try {
    return await materializeCardAttachments(
      trello,
      project.contextRoot,
      project.id,
      card.id,
      {
        signal,
        ...(project.maxAttachmentBytes === undefined
          ? {}
          : { maxAttachmentBytes: project.maxAttachmentBytes }),
        ...(project.maxTotalAttachmentBytes === undefined
          ? {}
          : { maxTotalAttachmentBytes: project.maxTotalAttachmentBytes }),
      },
    );
  } catch (error) {
    throw new WorkflowError(
      "Workflow",
      `Could not prepare Trello attachment context for project "${project.id}", card "${card.id}" at context root "${project.contextRoot}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function createCardAttachmentPromptContext(
  project: PollingProject,
  card: TrelloCard,
  manifest: CardAttachmentManifest | undefined,
): CardAttachmentPromptContext | undefined {
  if (project.contextRoot === undefined || manifest === undefined) {
    return undefined;
  }

  return {
    manifest,
    contextRoot: project.contextRoot,
    projectId: project.id,
    cardId: card.id,
  };
}
