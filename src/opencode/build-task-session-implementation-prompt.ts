import {
  buildCardAttachmentPromptLines,
  type CardAttachmentPromptContext,
} from "../context/card-attachment-prompt.js";
import type { TaskPlan } from "../task-session/task-plan.js";
import type { TrelloCard } from "../trello/trello-client.js";
import { taskSessionRepositoryGuidance } from "./task-session-prompt-guidance.js";

export interface TaskSessionImplementationPromptInput {
  projectId: string;
  card: TrelloCard;
  approvedPlan: TaskPlan;
  attachmentContext?: CardAttachmentPromptContext;
}

export function buildTaskSessionImplementationPrompt(
  input: TaskSessionImplementationPromptInput,
): string {
  if (
    input.approvedPlan.projectId !== input.projectId ||
    input.approvedPlan.cardId !== input.card.id
  ) {
    throw new Error(
      "Approved task plan does not match the implementation task identity",
    );
  }

  if (
    input.attachmentContext !== undefined &&
    (input.attachmentContext.projectId !== input.projectId ||
      input.attachmentContext.cardId !== input.card.id)
  ) {
    throw new Error(
      "Implementation attachment context does not match the task project and card",
    );
  }

  const description = input.card.desc.trim();

  return [
    "Implement the approved task plan in this repository using the current task worktree.",
    "",
    `Task identity: ${JSON.stringify({ projectId: input.projectId, cardId: input.card.id })}`,
    `Task title: ${JSON.stringify(input.card.name)}`,
    "Original task description:",
    description.length > 0
      ? description
      : "No additional description was provided.",
    ...buildCardAttachmentPromptLines(input.attachmentContext),
    "Approved plan:",
    JSON.stringify(input.approvedPlan, null, 2),
    ...taskSessionRepositoryGuidance,
    "Implement only the approved requirements and steps. Keep each requirement traceable to the plan and do not silently broaden scope.",
    "Do not run Git commands or invoke GitHub tools. Do not create commits, change branches, push, open pull requests, or modify the configured source checkout; the orchestrator owns all Git and GitHub operations.",
  ].join("\n");
}
