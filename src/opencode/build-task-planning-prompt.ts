import {
  buildCardAttachmentPromptLines,
  type CardAttachmentPromptContext,
} from "../context/card-attachment-prompt.js";
import type { TrelloAttachment, TrelloCard } from "../trello/trello-client.js";

function buildAttachmentMetadata(
  attachments: readonly TrelloAttachment[],
): string {
  return JSON.stringify(
    attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      isUpload: attachment.isUpload,
      ...(!attachment.isUpload ? { url: attachment.url } : {}),
    })),
    null,
    2,
  );
}

export function buildTaskPlanningPrompt(
  projectId: string,
  card: TrelloCard,
  attachments: readonly TrelloAttachment[] = [],
  attachmentContext?: CardAttachmentPromptContext,
): string {
  if (
    attachmentContext !== undefined &&
    (attachmentContext.projectId !== projectId ||
      attachmentContext.cardId !== card.id)
  ) {
    throw new Error(
      "Task planning attachment context does not match the task project and card",
    );
  }

  const description = card.desc.trim();

  return [
    "Prepare a structured plan for the task below. Do not implement the task.",
    "",
    `Task identity: ${JSON.stringify({ projectId, cardId: card.id })}`,
    `Task title: ${JSON.stringify(card.name)}`,
    "Original task description:",
    description.length > 0
      ? description
      : "No additional description was provided.",
    "",
    "Original Trello attachment metadata (uploaded file URLs are intentionally omitted):",
    buildAttachmentMetadata(attachments),
    ...buildCardAttachmentPromptLines(attachmentContext),
    "Inspect the repository source and read AGENTS.md and any relevant repository instructions before planning.",
    "Use attachment context when it clarifies the task requirements.",
    "Represent every explicit original requirement as a requirement with a stable ID, its original meaning, and a proposed verification method. Do not invent requirements or silently broaden scope.",
    "Map every requirement to at least one implementation step. Use requirement IDs from the requirements array in each step.",
    "Record assumptions and blockers explicitly; use empty arrays when there are none.",
    "Return only one valid JSON object matching this schema. Do not use Markdown fences or include prose outside the object:",
    JSON.stringify(
      {
        version: 1,
        projectId,
        cardId: card.id,
        requirements: [
          {
            id: "REQ-1",
            text: "Original requirement",
            verification: "How to verify",
          },
        ],
        steps: [
          {
            id: "STEP-1",
            description: "Implementation step",
            requirementIds: ["REQ-1"],
            verification: "How to verify the step",
          },
        ],
        assumptions: [],
        blockers: [],
      },
      null,
      2,
    ),
    "Do not modify repository files, run commands, create commits, push branches, or open pull requests while preparing this plan.",
  ].join("\n");
}
