import type { TrelloCard } from "../trello/trello-client.js";

import {
  commitResultRelativePath,
  MAX_COMMIT_MESSAGE_LENGTH,
} from "./commit-result.js";

export function buildCommitPrompt(card: TrelloCard): string {
  return [
    "Generate the commit message for the final reviewed changes for this task.",
    "",
    `Task: ${card.name}`,
    "",
    "Inspect the complete Git status and diff before generating the message.",
    "Do not modify any repository file other than the required result artifact.",
    "Do not stage files.",
    "Do not create or amend commits.",
    "Do not push anything.",
    "",
    `Write exactly one JSON object to ${commitResultRelativePath}.`,
    "The artifact is the only permitted repository write.",
    "Do not put the result in stdout; stdout is not authoritative.",
    `The message must be at most ${MAX_COMMIT_MESSAGE_LENGTH} characters and preserve real line breaks.`,
    "",
    "Use this commit-message format:",
    "",
    "type(scope): summary",
    "",
    "- Bullet point 1.",
    "- Bullet point 2.",
    "",
    "Final sentence describing the overall impact.",
    "",
    "Choose the appropriate Conventional Commit type such as feat, fix, refactor, docs, test, build, ci, or chore.",
    "Base the message on the actual final changes.",
    "Do not include AI attribution.",
    "The JSON object must contain exactly one field named message.",
    "Do not include Markdown fences, explanation, or any additional fields.",
  ].join("\n");
}
