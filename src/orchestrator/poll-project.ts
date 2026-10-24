import type { ProjectConfig } from "../config/config.js";
import type { CardAttachmentPromptContext } from "../context/card-attachment-prompt.js";
import {
  withActiveCardContext,
  withActiveProjectContext,
} from "../context/active-card-context.js";
import {
  materializeCardAttachments,
  type CardAttachmentManifest,
} from "../context/materialize-card-attachments.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import { logger, type Logger } from "../logging/logger.js";
import type { EmailNotifier } from "../notifications/email-notifier.js";
import type { OpenCodeClient } from "../opencode/opencode-client.js";
import type { CommandRunner } from "../process/command-runner.js";
import { runRefinementCardWorkflow } from "../refinement/run-refinement-card.js";
import { runTaskSessionWorkflow } from "./run-task-session-workflow.js";
import { WorkflowError } from "./workflow-error.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";

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
    manifest = await materializeCardAttachments(
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
        onSuccessfulReconciliation: (summary) => {
          cardLog.event(
            `Trello attachment context refreshed: reused uploaded attachments: ${summary.reusedUploadedAttachments}; newly downloaded uploaded attachments: ${summary.downloadedUploadedAttachments}; removed stale managed attachments: ${summary.removedStaleManagedAttachments}; external URL attachments: ${summary.externalUrlAttachments}; total current attachments: ${summary.totalCurrentAttachments}`,
          );
        },
      },
    );
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
  signal: AbortSignal,
  emailNotifier?: EmailNotifier,
  onHumanReviewCardsObserved?: (cardIds: string[]) => void,
  onHumanReviewCardLeft?: (cardId: string) => void,
): Promise<void> {
  if (signal.aborted) return;

  await withActiveProjectContext(project.id, () =>
    runTaskSessionWorkflow({
      project,
      trello,
      git,
      github,
      openCode: opencode,
      commands,
      signal,
      ...(emailNotifier === undefined ? {} : { emailNotifier }),
      ...(onHumanReviewCardsObserved === undefined
        ? {}
        : { onHumanReviewCardsObserved }),
      ...(onHumanReviewCardLeft === undefined ? {} : { onHumanReviewCardLeft }),
      prepareAttachmentContext: async (card) => {
        const cardLog = logger.child({
          projectId: project.id,
          cardId: card.id,
        });
        return prepareAttachmentPromptContext(
          trello,
          project,
          card,
          signal,
          cardLog,
        );
      },
      processRefinement: async (card, worktree) =>
        withActiveCardContext(project.id, card.id, () =>
          runRefinementCardWorkflow({
            trello,
            git,
            openCode: opencode,
            project,
            card,
            signal,
            preparedWorktree: worktree,
            ...(emailNotifier === undefined ? {} : { emailNotifier }),
            prepareAttachmentContext: (refinementCard, cardLog) =>
              prepareAttachmentPromptContext(
                trello,
                project,
                refinementCard,
                signal,
                cardLog,
              ),
          }),
        ),
    }),
  );
}
