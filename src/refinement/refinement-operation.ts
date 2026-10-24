import type { ProjectConfig } from "../config/config.js";
import type { CardAttachmentPromptContext } from "../context/card-attachment-prompt.js";
import type { GitClient } from "../git/git-client.js";
import type { Logger } from "../logging/logger.js";
import {
  notifyRefinementCompletion,
  type EmailNotifier,
} from "../notifications/email-notifier.js";
import type { OpenCodeClient } from "../opencode/opencode-client.js";
import { addRefinementCompletionComment } from "../refinement/refinement-completion.js";
import { finalizeRefinement } from "../refinement/finalize-refinement.js";
import { runRefinement } from "../refinement/run-refinement.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";
import { getElapsedRefinementWorkflowTime } from "../orchestrator/workflow-duration.js";

/** Executes the refinement action and its Trello completion side effects. */
export async function runRefinementOperation(input: {
  trello: TrelloClient;
  git: GitClient;
  opencode: OpenCodeClient;
  project: ProjectConfig;
  card: TrelloCard;
  worktreePath: string;
  signal: AbortSignal;
  cardLog: Logger;
  attachmentContext?: CardAttachmentPromptContext;
  emailNotifier?: EmailNotifier;
}): Promise<void> {
  const result = await runRefinement(
    input.git,
    input.opencode,
    input.project,
    input.card,
    input.worktreePath,
    input.signal,
    input.attachmentContext,
  );

  input.cardLog.event(
    `OpenCode refinement completed with classification: ${result.type}`,
  );

  await finalizeRefinement(
    input.trello,
    input.project,
    input.card,
    result,
    input.signal,
  );

  input.cardLog.event("Refined card returned to Backlog");

  const elapsedWorkflowTime = await getElapsedRefinementWorkflowTime(
    input.trello,
    input.project,
    input.card.id,
    input.cardLog,
  );

  await notifyRefinementCompletion(
    input.emailNotifier,
    {
      project: input.project,
      card: input.card,
      result,
      ...(elapsedWorkflowTime === undefined ? {} : { elapsedWorkflowTime }),
    },
    input.cardLog,
  );

  await addRefinementCompletionComment(
    input.trello,
    input.card,
    result,
    input.cardLog,
    elapsedWorkflowTime,
  );
}
