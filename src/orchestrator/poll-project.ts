import type { ProjectConfig } from "../config/config.js";
import type { CardAttachmentPromptContext } from "../context/card-attachment-prompt.js";
import { withActiveCardContext, withActiveProjectContext } from "../context/active-card-context.js";
import {
  materializeCardAttachments,
  type CardAttachmentManifest,
} from "../context/materialize-card-attachments.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import { logger, type Logger } from "../logging/logger.js";
import type { EmailNotifier } from "../notifications/email-notifier.js";
import {
  drainNotifications,
  NotificationPreparationError,
  deferNotificationPreparation,
  notificationPreparationDue,
} from "../notifications/notification-outbox.js";
import type { OpenCodeClient } from "../opencode/opencode-client.js";
import type { CommandRunner } from "../process/command-runner.js";
import { runRefinementCardWorkflow } from "../refinement/run-refinement-card.js";
import { runTaskSessionWorkflow } from "./run-task-session-workflow.js";
import { WorkflowError } from "./workflow-error.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";
import type { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { reconcileWorkflowMutations } from "./reconcile-workflow-mutations.js";
import { withActivePrObservation, observeActivePullRequest } from "./active-pr-observation.js";
import {
  readTerminalPrFence,
  withTerminalWriterCancellation,
  isTerminalPrInterruption,
} from "../task-session/terminal-pr-fence.js";

export type PollingProject = ProjectConfig & {
  contextRoot?: string;
  maxAttachmentBytes?: number;
  maxTotalAttachmentBytes?: number;
};

async function prepareAttachmentPromptContext(
  trello: TrelloClient,
  project: PollingProject,
  card: TrelloCard,
  signal: AbortSignal,
  cardLog: Logger,
): Promise<CardAttachmentPromptContext | undefined> {
  if (project.contextRoot === undefined) return undefined;

  let manifest: CardAttachmentManifest | undefined;
  try {
    manifest = await materializeCardAttachments(trello, project.contextRoot, project.id, card.id, {
      signal,
      ...(project.maxAttachmentBytes === undefined
        ? {}
        : { maxAttachmentBytes: project.maxAttachmentBytes }),
      ...(project.maxTotalAttachmentBytes === undefined
        ? {}
        : { maxTotalAttachmentBytes: project.maxTotalAttachmentBytes }),
      onSuccessfulReconciliation: (summary) => {
        cardLog.event(
          `Trello attachment context refreshed: reused uploaded attachments: ${summary.reusedUploadedAttachments}; newly downloaded uploaded attachments: ${summary.downloadedUploadedAttachments}; removed stale managed attachments: ${summary.removedStaleManagedAttachments}; external URL attachments: ${summary.externalUrlAttachments}; total current attachments: ${summary.totalCurrentAttachments}`,
        );
      },
    });
  } catch (error) {
    throw new WorkflowError(
      "Workflow",
      `Could not prepare Trello attachment context for project "${project.id}", card "${card.id}" at context root "${project.contextRoot}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (manifest === undefined) return undefined;
  return {
    manifest,
    contextRoot: project.contextRoot,
    projectId: project.id,
    cardId: card.id,
  };
}

export async function pollProject(
  trello: TrelloClient,
  git: GitClient,
  github: GitHubClient,
  opencode: OpenCodeClient,
  commands: CommandRunner,
  project: PollingProject,
  rootSignal: AbortSignal,
  emailNotifier?: EmailNotifier,
  onHumanReviewCardsObserved?: (cardIds: string[]) => void,
  onHumanReviewCardLeft?: (cardId: string) => void,
  authority?: ProjectRunAuthority,
  retryIntervalMs?: number,
): Promise<void> {
  if (rootSignal.aborted) return;
  let executionSignal = rootSignal;

  const execute = (signal: AbortSignal = rootSignal) =>
    withActiveProjectContext(project.id, async () => {
      drainNotifications(project.id, emailNotifier, (message) =>
        logger.child({ projectId: project.id }).warn(message),
      );
      if (authority)
        await observeActivePullRequest({
          project,
          github,
          authority,
          terminalOnly: true,
        });
      if (signal.aborted) return;
      if (await reconcileWorkflowMutations({ project, trello, github, git })) return;
      if (!notificationPreparationDue(project.id)) return;
      return runTaskSessionWorkflow({
        project,
        trello,
        git,
        github,
        openCode: opencode,
        commands,
        signal,
        ...(retryIntervalMs === undefined ? {} : { retryIntervalMs }),
        ...(emailNotifier === undefined ? {} : { emailNotifier }),
        ...(onHumanReviewCardsObserved === undefined ? {} : { onHumanReviewCardsObserved }),
        ...(onHumanReviewCardLeft === undefined ? {} : { onHumanReviewCardLeft }),
        prepareAttachmentContext: async (card) => {
          const cardLog = logger.child({
            projectId: project.id,
            cardId: card.id,
          });
          return prepareAttachmentPromptContext(trello, project, card, signal, cardLog);
        },
        processRefinement: async (card, worktree) =>
          withActiveCardContext(project.id, card.id, () =>
            runRefinementCardWorkflow({
              trello,
              git,
              commands,
              openCode: opencode,
              project,
              card,
              signal,
              preparedWorktree: worktree,
              ...(emailNotifier === undefined ? {} : { emailNotifier }),
              prepareAttachmentContext: (refinementCard, cardLog) =>
                prepareAttachmentPromptContext(trello, project, refinementCard, signal, cardLog),
            }),
          ),
      });
    });
  try {
    if (authority)
      await authority.run(() =>
        withTerminalWriterCancellation(authority, rootSignal, (signal) => {
          executionSignal = signal;
          return withActivePrObservation(
            {
              project,
              github,
              authority,
              intervalMs: retryIntervalMs ?? 15_000,
              signal: rootSignal,
              onError: () =>
                logger
                  .child({ projectId: project.id })
                  .warn(
                    "Active PR observation deferred after an external read failure; retained arrivals and writer state are unchanged",
                  ),
            },
            () => execute(signal),
          );
        }),
      );
    else await execute();
  } catch (error) {
    if (
      readTerminalPrFence(authority) &&
      (executionSignal.aborted || isTerminalPrInterruption(error))
    ) {
      logger
        .child({ projectId: project.id })
        .info(
          "Human PR outcome fenced automated work; preserving execution state for terminal reconciliation",
        );
      return;
    }
    if (error instanceof NotificationPreparationError) {
      const defer = () =>
        deferNotificationPreparation(project.id, (message) =>
          logger.child({ projectId: project.id }).warn(message),
        );
      if (authority) authority.run(defer);
      else defer();
      return;
    }
    if (
      !authority?.store
        .read()
        ?.pendingOperations.some(
          (entry) =>
            entry.id.startsWith("workflow:") && !["completed", "cancelled"].includes(entry.status),
        )
    )
      throw error;
    logger
      .child({ projectId: project.id })
      .info(
        "Pending workflow effect retains project ownership; reconciliation will precede further work",
      );
  }
}
