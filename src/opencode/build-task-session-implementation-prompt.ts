import {
  buildCardAttachmentPromptLines,
  type CardAttachmentPromptContext,
} from "../context/card-attachment-prompt.js";
import type { TaskPlan } from "../task-session/task-plan.js";
import type { PlanVerificationResult } from "../task-session/plan-verification.js";
import type { TrelloCard } from "../trello/trello-client.js";
import { taskSessionRepositoryGuidance } from "./task-session-prompt-guidance.js";

export interface TaskSessionImplementationPromptInput {
  projectId: string;
  card: TrelloCard;
  approvedPlan?: TaskPlan;
  planReviewAdvice?: PlanVerificationResult;
  planRevision?: number;
  attachmentContext?: CardAttachmentPromptContext;
}

export function buildTaskSessionImplementationPrompt(
  input: TaskSessionImplementationPromptInput,
): string {
  if (
    input.approvedPlan !== undefined &&
    (input.approvedPlan.projectId !== input.projectId ||
      input.approvedPlan.cardId !== input.card.id)
  ) {
    throw new Error("Approved task plan does not match the implementation task identity");
  }

  if (
    input.planReviewAdvice !== undefined &&
    (input.approvedPlan === undefined ||
      input.planRevision !== input.planReviewAdvice.planRevision ||
      input.planReviewAdvice.projectId !== input.projectId ||
      input.planReviewAdvice.cardId !== input.card.id)
  ) {
    throw new Error(
      "Independent plan-review advice does not match the implementation task and plan revision",
    );
  }

  if (
    input.attachmentContext !== undefined &&
    (input.attachmentContext.projectId !== input.projectId ||
      input.attachmentContext.cardId !== input.card.id)
  ) {
    throw new Error("Implementation attachment context does not match the task project and card");
  }

  const description = input.card.desc.trim();

  return [
    input.approvedPlan === undefined
      ? "Implement the original task in this repository using the current task worktree. Planning advice was unavailable or unusable; use the task, repository, and attachments to determine a scoped implementation without inventing requirements."
      : "Implement the task plan in this repository using the current task worktree.",
    "",
    `Task identity: ${JSON.stringify({ projectId: input.projectId, cardId: input.card.id })}`,
    `Task title: ${JSON.stringify(input.card.name)}`,
    "Original task description:",
    description.length > 0 ? description : "No additional description was provided.",
    ...buildCardAttachmentPromptLines(input.attachmentContext),
    "Task plan (advisory; may be absent):",
    input.approvedPlan === undefined
      ? "No usable plan was available."
      : JSON.stringify(input.approvedPlan, null, 2),
    "Independent plan-review recommendations (advisory only; no approval is required):",
    input.planReviewAdvice === undefined
      ? "No independent plan-review recommendations are available."
      : JSON.stringify(input.planReviewAdvice, null, 2),
    ...taskSessionRepositoryGuidance,
    input.approvedPlan === undefined
      ? "Implement only behavior supported by the original task and repository evidence; do not silently broaden scope."
      : "Treat the plan as advisory. Adopt, adapt, or disregard it while preserving the original task scope; do not silently broaden scope.",
    "Treat independent plan-review findings as optional recommendations: adopt, adapt, or disregard them based on the original task and repository evidence. They are not approval requirements.",
    "Do not run Git commands or invoke GitHub tools. Do not create commits, change branches, push, open pull requests, or modify the configured source checkout; the orchestrator owns all Git and GitHub operations.",
  ].join("\n");
}
