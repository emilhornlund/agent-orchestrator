import {
  buildCardAttachmentPromptLines,
  type CardAttachmentPromptContext,
} from "../context/card-attachment-prompt.js";
import type { FeedbackLedgerEntry } from "../task-session/feedback-ledger.js";
import type { TaskPlan } from "../task-session/task-plan.js";
import type { TrelloCard } from "../trello/trello-client.js";
import { taskSessionRepositoryGuidance } from "./task-session-prompt-guidance.js";

export interface TaskSessionFeedbackRemediationPromptInput {
  projectId: string;
  card: TrelloCard;
  approvedPlan: TaskPlan;
  currentHeadSha: string;
  operationId: string;
  actionableFeedback: readonly FeedbackLedgerEntry[];
  attachmentContext?: CardAttachmentPromptContext;
}

export function buildTaskSessionFeedbackRemediationPrompt(
  input: TaskSessionFeedbackRemediationPromptInput,
): string {
  if (
    input.approvedPlan.projectId !== input.projectId ||
    input.approvedPlan.cardId !== input.card.id
  ) {
    throw new Error("Feedback remediation plan does not match task ownership");
  }
  if (
    input.attachmentContext !== undefined &&
    (input.attachmentContext.projectId !== input.projectId ||
      input.attachmentContext.cardId !== input.card.id)
  ) {
    throw new Error(
      "Feedback remediation attachment context does not match task ownership",
    );
  }
  if (input.actionableFeedback.length === 0) {
    throw new Error("Feedback remediation requires actionable ledger items");
  }
  return [
    "Address the following verified-as-actionable human PR feedback in the existing primary task session.",
    "",
    `Task identity: ${JSON.stringify({ projectId: input.projectId, cardId: input.card.id })}`,
    `Feedback remediation operation: ${JSON.stringify(input.operationId)}`,
    `Current PR head: ${input.currentHeadSha}`,
    `Task title: ${JSON.stringify(input.card.name)}`,
    "Original task description:",
    input.card.desc.trim().length > 0
      ? input.card.desc
      : "No additional description was provided.",
    ...buildCardAttachmentPromptLines(input.attachmentContext),
    "Approved plan:",
    JSON.stringify(input.approvedPlan, null, 2),
    "Current task source:",
    "Inspect the current code and tests in this worktree before making changes; do not assume prior feedback or implementation context is still accurate.",
    "Pending actionable feedback (all items must remain represented until independently verified):",
    JSON.stringify(input.actionableFeedback, null, 2),
    ...taskSessionRepositoryGuidance,
    "Make only changes needed to address these feedback items while preserving the approved task scope. Leave changes in the worktree for orchestrator-owned validation, coverage, and independent review.",
    "Do not run Git commands or invoke GitHub tools. Do not create commits, change branches, push, open pull requests, reply to comments, or resolve threads; the orchestrator owns all Git and GitHub operations.",
  ].join("\n");
}
