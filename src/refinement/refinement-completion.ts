import type { Logger } from "../logging/logger.js";
import { WorkflowMutationWaitingError } from "../task-session/workflow-mutation.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";

import type { RefinementResult } from "./refinement-result.js";
import { z } from "zod";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { sanitizeControlledText } from "../security/redact-secrets.js";

export const refinementCompletionKey = "refinement-completion-v1";
export const refinementCompletionSchema = z.strictObject({
  text: z.string().min(1),
  verified: z.boolean(),
});

export function buildRefinementCompletionComment(
  result: RefinementResult,
  elapsedWorkflowTime?: string,
): string {
  return [
    "Agent Orchestrator completed refinement.",
    "",
    `Classification: ${result.type}`,
    `Refined task title: ${result.title}`,
    ...(elapsedWorkflowTime === undefined ? [] : [`Elapsed workflow time: ${elapsedWorkflowTime}`]),
  ].join("\n");
}

export async function addRefinementCompletionComment(
  trello: TrelloClient,
  card: TrelloCard,
  result: RefinementResult,
  cardLog: Logger,
  elapsedWorkflowTime?: string,
): Promise<void> {
  const projectId = ProjectRunAuthority.currentProjectId();
  const authority = projectId ? ProjectRunAuthority.current(projectId) : undefined;
  let state = authority?.read(refinementCompletionKey, refinementCompletionSchema.parse) ?? {
    text: sanitizeControlledText(buildRefinementCompletionComment(result, elapsedWorkflowTime)),
    verified: false,
  };
  const save = () =>
    authority?.mutate(
      refinementCompletionKey,
      state,
      () => ({ value: state, result: undefined }),
      refinementCompletionSchema.parse,
    );
  if (state.verified) return;
  save();
  try {
    await trello.addComment(card.id, state.text);
    state = { ...state, verified: true };
    save();
    cardLog.info("Trello card updated with refinement summary");
  } catch (error) {
    if (authority) throw error;
    if (error instanceof WorkflowMutationWaitingError) throw error;
    cardLog.error(
      `Failed to add refinement summary to Trello card: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
