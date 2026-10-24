import type { ProjectConfig } from "../config/config.js";
import type { CardAttachmentPromptContext } from "../context/card-attachment-prompt.js";
import { cleanupWorktree } from "../git/cleanup-worktree.js";
import type { GitClient } from "../git/git-client.js";
import { prepareWorktree } from "../git/prepare-worktree.js";
import { logger, type Logger } from "../logging/logger.js";
import type { EmailNotifier } from "../notifications/email-notifier.js";
import {
  OpenCodeRunAbortedError,
  type OpenCodeClient,
} from "../opencode/opencode-client.js";
import { CommandRunAbortedError } from "../process/command-runner.js";
import {
  clearRefinementResult,
  getRefinementResultPath,
} from "./refinement-result.js";
import { runRefinementOperation } from "./refinement-operation.js";
import {
  TrelloRequestAbortedError,
  type TrelloCard,
  type TrelloClient,
} from "../trello/trello-client.js";
import { failCard } from "../orchestrator/fail-card.js";

export type RefinementProject = ProjectConfig & {
  contextRoot?: string;
  maxAttachmentBytes?: number;
  maxTotalAttachmentBytes?: number;
};

function isWorkflowAbort(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
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

function reportCleanupFailure(
  cardLog: Logger,
  project: RefinementProject,
  card: TrelloCard,
  artifact: string,
  error: unknown,
): void {
  cardLog.warn(
    `Housekeeping cleanup warning for project "${project.id}", card "${card.id}": could not remove ${artifact}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

export async function runRefinementCardWorkflow(options: {
  trello: TrelloClient;
  git: GitClient;
  openCode: OpenCodeClient;
  project: RefinementProject;
  card: TrelloCard;
  signal: AbortSignal;
  emailNotifier?: EmailNotifier;
  preparedWorktree?: { path: string; branch: string };
  prepareAttachmentContext: (
    card: TrelloCard,
    cardLog: Logger,
  ) => Promise<CardAttachmentPromptContext | undefined>;
}): Promise<void> {
  const { trello, git, openCode, project, card, signal } = options;
  const cardLog = logger.child({ projectId: project.id, cardId: card.id });
  cardLog.event(`Claimed refinement card: ${card.name}`);
  let worktree: { path: string; branch: string } | undefined;
  let cardContextPreparationFailed = false;

  try {
    worktree =
      options.preparedWorktree ??
      (await prepareWorktree(git, project, card.id));
    cardLog.info(`Branch: ${worktree.branch}`);
    cardLog.info(`Worktree: ${worktree.path}`);
    cardContextPreparationFailed = true;
    const attachmentContext = await options.prepareAttachmentContext(
      card,
      cardLog,
    );
    cardContextPreparationFailed = false;

    cardLog.event("Starting OpenCode refinement...");
    await runRefinementOperation({
      trello,
      git,
      opencode: openCode,
      project,
      card,
      worktreePath: worktree.path,
      signal,
      cardLog,
      ...(attachmentContext === undefined ? {} : { attachmentContext }),
      ...(options.emailNotifier === undefined
        ? {}
        : { emailNotifier: options.emailNotifier }),
    });

    if (signal.aborted) return;
    try {
      clearRefinementResult(worktree.path);
    } catch (error) {
      reportCleanupFailure(
        cardLog,
        project,
        card,
        getRefinementResultPath(worktree.path),
        error,
      );
    }

    cardLog.info("Cleaning up refinement worktree...");
    try {
      await cleanupWorktree({
        git,
        project,
        worktreePath: worktree.path,
        branch: worktree.branch,
        preserveRecoveryState: true,
        signal,
      });
    } catch (error) {
      reportCleanupFailure(
        cardLog,
        project,
        card,
        `${worktree.path} and ${worktree.branch}`,
        error,
      );
    }
  } catch (error) {
    if (isWorkflowAbort(error, signal)) {
      cardLog.event("Refinement workflow interrupted by orchestrator shutdown");
      return;
    }

    if (worktree !== undefined && !cardContextPreparationFailed) {
      cardLog.info("Resetting failed refinement worktree...");
      try {
        clearRefinementResult(worktree.path);
        await git.resetHard(worktree.path);
        await git.cleanUntracked(worktree.path);
        cardLog.info("Failed refinement worktree reset");
      } catch (cleanupError) {
        cardLog.error(
          `Failed to reset refinement worktree: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    }

    await failCard(
      trello,
      project,
      card.id,
      error,
      options.emailNotifier,
      card,
    );
  }
}
