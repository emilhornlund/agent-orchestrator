import type { TrelloCard } from "../trello/trello-client.js";
import {
  buildCardAttachmentPromptLines,
  type CardAttachmentPromptContext,
} from "../context/card-attachment-prompt.js";

export function buildRemediationPrompt(
  card: TrelloCard,
  reviewOutput: string,
  validationCommand?: string,
  attachmentContext?: CardAttachmentPromptContext,
): string {
  return [
    "Fix the issues found by the review of the current uncommitted changes.",
    "",
    `Task: ${card.name}`,
    "",
    "Review findings:",
    reviewOutput.trim(),
    ...buildCardAttachmentPromptLines(attachmentContext),
    "",
    "Inspect the repository and current changes before editing.",
    "Address the review findings completely.",
    ...(validationCommand
      ? [
          `Run the configured repository validation command: \`${validationCommand}\` before finishing.`,
        ]
      : ["Run the repository's appropriate validation checks."]),
    "Leave the repository validation passing before finishing.",
    "Do not create commits.",
    "Do not push anything.",
    "Do not open pull requests.",
  ].join("\n");
}
