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
  InvalidRefinementResultError,
} from "./refinement-result.js";
import { runRefinementOperation } from "./refinement-operation.js";
import {
  TrelloRequestAbortedError,
  type TrelloCard,
  type TrelloClient,
} from "../trello/trello-client.js";
import { failCard } from "../orchestrator/fail-card.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import type { CommandRunner } from "../process/command-runner.js";
import {
  RefinementSetupAmbiguousError,
  RefinementSetupFailedError,
  assertRefinementSetupBaselineUnchanged,
  runRefinementSetup,
} from "./run-refinement-setup.js";
import {
  refinementInput,
  recordRefinementAnalysisFailure,
} from "./refinement-input.js";
import { RefinementAnalysisFailedError } from "./run-refinement.js";

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
  commands: CommandRunner;
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
  const authority = ProjectRunAuthority.current(project.id);
  const input = authority ? refinementInput(authority, card) : undefined;

  try {
    worktree =
      options.preparedWorktree ??
      (await prepareWorktree(git, project, card.id));
    cardLog.info(`Branch: ${worktree.branch}`);
    cardLog.info(`Worktree: ${worktree.path}`);
    const postSetupBaseline = await runRefinementSetup({
      commands: options.commands,
      git,
      project,
      cardId: card.id,
      worktreePath: worktree.path,
      signal,
      cardLog,
    });
    if (postSetupBaseline !== undefined) {
      try {
        await assertRefinementSetupBaselineUnchanged({
          git,
          worktreePath: worktree.path,
          baseline: postSetupBaseline,
          signal,
        });
      } catch (error) {
        if (error instanceof RefinementSetupAmbiguousError) throw error;
        throw new RefinementSetupAmbiguousError(
          "Could not inspect the worktree against its persisted post-setup baseline; preserving it and blocking refinement dispatch",
          { cause: error },
        );
      }
    }
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
      card: input
        ? {
            ...card,
            name: input.original.title,
            desc: input.original.description,
            idLabels: input.original.labels,
          }
        : card,
      worktreePath: worktree.path,
      ...(postSetupBaseline === undefined
        ? {}
        : { repositoryBaseline: postSetupBaseline }),
      signal,
      cardLog,
      refreshAttachments: async () =>
        options.prepareAttachmentContext(
          await trello.getCard(card.id),
          cardLog,
        ),
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
    if (
      authority &&
      (error instanceof InvalidRefinementResultError ||
        error instanceof RefinementAnalysisFailedError)
    ) {
      recordRefinementAnalysisFailure(
        authority,
        "Refinement did not complete after bounded analysis/correction; original card fields and diagnostics are preserved",
      );
      throw new RefinementSetupFailedError(
        "Refinement analysis exhausted its bounded correction allowance",
        { cause: error },
      );
    }
    if (error instanceof NotificationPreparationError) throw error;
    if (
      error instanceof RefinementSetupAmbiguousError ||
      error instanceof RefinementSetupFailedError
    )
      throw error;
    if (
      ProjectRunAuthority.current(project.id)
        ?.store.read()
        ?.pendingOperations.some(
          (entry) =>
            entry.mutation &&
            !["completed", "cancelled", "failed"].includes(entry.status),
        )
    )
      throw error;
    if (isWorkflowAbort(error, signal)) {
      cardLog.event("Refinement workflow interrupted by orchestrator shutdown");
      return;
    }
    if (authority)
      throw new RefinementSetupAmbiguousError(
        "Refinement has no verified terminal outcome; preserve current card/worktree state and reconcile before further work",
        { cause: error },
      );

    if (worktree !== undefined && !cardContextPreparationFailed) {
      try {
        clearRefinementResult(worktree.path);
      } catch (cleanupError) {
        reportCleanupFailure(
          cardLog,
          project,
          card,
          getRefinementResultPath(worktree.path),
          cleanupError,
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
import { NotificationPreparationError } from "../notifications/notification-outbox.js";
