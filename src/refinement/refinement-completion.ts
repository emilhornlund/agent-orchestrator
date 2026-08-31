import type { Logger } from "../logging/logger.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";

import type { RefinementResult } from "./refinement-result.js";

export function buildRefinementCompletionComment(
  result: RefinementResult,
): string {
  return [
    "Agent Orchestrator completed refinement.",
    "",
    `Classification: ${result.type}`,
    `Refined task title: ${result.title}`,
    "",
    "Refined task description:",
    result.description,
  ].join("\n");
}

export async function addRefinementCompletionComment(
  trello: TrelloClient,
  card: TrelloCard,
  result: RefinementResult,
  cardLog: Logger,
): Promise<void> {
  try {
    await trello.addComment(card.id, buildRefinementCompletionComment(result));
    cardLog.info("Trello card updated with refinement summary");
  } catch (error) {
    cardLog.error(
      `Failed to add refinement summary to Trello card: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
