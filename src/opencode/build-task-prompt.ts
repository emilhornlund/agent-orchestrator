import type { TrelloCard } from "../trello/trello-client.js";
import {
  buildCardAttachmentPromptLines,
  type CardAttachmentPromptContext,
} from "../context/card-attachment-prompt.js";
import { buildValidationPromptLines } from "./build-validation-prompt.js";

export function buildTaskPrompt(
  card: TrelloCard,
  validationCommand?: string,
  attachmentContext?: CardAttachmentPromptContext,
): string {
  const description = card.desc.trim();

  return [
    "Implement the following task in this repository.",
    "",
    `Task: ${card.name}`,
    "",
    description.length > 0
      ? `Description:\n${description}`
      : "No additional task description was provided.",
    ...buildCardAttachmentPromptLines(attachmentContext),
    "",
    "Work directly in the current repository.",
    "Inspect the existing code before making changes.",
    "Follow the repository's existing conventions and instructions.",
    ...buildValidationPromptLines(validationCommand),
    "Do not create commits, push branches, or open pull requests.",
  ].join("\n");
}
