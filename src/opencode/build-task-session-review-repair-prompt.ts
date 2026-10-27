import {
  buildCardAttachmentPromptLines,
  type CardAttachmentPromptContext,
} from "../context/card-attachment-prompt.js";
import type { ImplementationReviewResult } from "../task-session/implementation-review-result.js";
import type { TaskPlan } from "../task-session/task-plan.js";
import type { TrelloCard } from "../trello/trello-client.js";
import { taskSessionRepositoryGuidance } from "./task-session-prompt-guidance.js";

export interface TaskSessionReviewRepairPromptInput {
  projectId: string;
  card: TrelloCard;
  approvedPlan: TaskPlan;
  review: ImplementationReviewResult;
  attempt: number;
  maxAttempts: number;
  attachmentContext?: CardAttachmentPromptContext;
}

export function buildTaskSessionReviewRepairPrompt(
  input: TaskSessionReviewRepairPromptInput,
): string {
  if (
    input.approvedPlan.projectId !== input.projectId ||
    input.approvedPlan.cardId !== input.card.id ||
    input.review.projectId !== input.projectId ||
    input.review.cardId !== input.card.id
  ) {
    throw new Error(
      "Review repair artifacts do not match the task project and card",
    );
  }

  if (
    input.attachmentContext !== undefined &&
    (input.attachmentContext.projectId !== input.projectId ||
      input.attachmentContext.cardId !== input.card.id)
  ) {
    throw new Error(
      "Review repair attachment context does not match the task project and card",
    );
  }

  return [
    "Address the independent implementation review findings in the existing primary task session.",
    "",
    `Task identity: ${JSON.stringify({ projectId: input.projectId, cardId: input.card.id })}`,
    `Task title: ${JSON.stringify(input.card.name)}`,
    "Original task description:",
    input.card.desc.trim().length > 0
      ? input.card.desc
      : "No additional description was provided.",
    ...buildCardAttachmentPromptLines(input.attachmentContext),
    "Approved plan:",
    JSON.stringify(input.approvedPlan, null, 2),
    "Latest independent review result and blocking findings:",
    JSON.stringify(input.review, null, 2),
    ...taskSessionRepositoryGuidance,
    `This is bounded review remediation attempt ${input.attempt} of ${input.maxAttempts}.`,
    "Before changing anything, inspect the relevant implementation and existing tests for the review findings.",
    "Address every blocking finding; do not focus only on the first or leave any finding without explicit consideration.",
    "For each blocking finding, understand the underlying defect, identify and implement the smallest complete correction, and add or update regression tests when appropriate.",
    "After addressing the findings, ensure the original approved requirements remain satisfied. Keep changes within the approved task scope; do not broaden the task.",
    "Do not make superficial changes that merely silence a test or match review wording. Fix the underlying problem rather than hiding its symptoms.",
    "Continue in this primary task session and its existing repository/worktree context. Do not start another AI session or remediation stage.",
    "Leave repository changes in the worktree for orchestrator-owned validation and review; do not run orchestrator-owned validation yourself.",
    "Do not run Git commands or invoke GitHub tools. Do not create commits, change branches, push, or open pull requests; the orchestrator owns all Git and GitHub operations.",
  ].join("\n");
}
