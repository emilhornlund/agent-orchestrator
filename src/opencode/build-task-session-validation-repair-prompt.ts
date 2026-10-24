import {
  buildCardAttachmentPromptLines,
  type CardAttachmentPromptContext,
} from "../context/card-attachment-prompt.js";
import type { TrelloCard } from "../trello/trello-client.js";
import type { TaskPlan } from "../task-session/task-plan.js";
import type { TaskSessionValidationResult } from "../task-session/run-task-session-validation.js";
import { taskSessionRepositoryGuidance } from "./task-session-prompt-guidance.js";

export interface TaskSessionValidationRepairPromptInput {
  projectId: string;
  card: TrelloCard;
  approvedPlan: TaskPlan;
  validation: TaskSessionValidationResult;
  coverage?: TaskSessionValidationResult | null;
  attempt: number;
  maxAttempts: number;
  attachmentContext?: CardAttachmentPromptContext;
}

export function buildTaskSessionValidationRepairPrompt(
  input: TaskSessionValidationRepairPromptInput,
): string {
  if (
    input.approvedPlan.projectId !== input.projectId ||
    input.approvedPlan.cardId !== input.card.id
  ) {
    throw new Error(
      "Approved plan does not match the validation repair task identity",
    );
  }

  if (
    input.attachmentContext !== undefined &&
    (input.attachmentContext.projectId !== input.projectId ||
      input.attachmentContext.cardId !== input.card.id)
  ) {
    throw new Error(
      "Validation repair attachment context does not match the task project and card",
    );
  }

  return [
    "Repair the failing local quality gate for this task using the existing primary task session.",
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
    ...taskSessionRepositoryGuidance,
    `This is bounded validation repair attempt ${input.attempt} of ${input.maxAttempts}.`,
    `Validation command: ${JSON.stringify(input.validation.command)}`,
    `Validation status: ${input.validation.status}`,
    `Validation exit code: ${input.validation.exitCode === null ? "unavailable" : input.validation.exitCode}`,
    `Validation source snapshot: ${input.validation.contentIdentity}`,
    "Bounded, redacted validation diagnostics:",
    input.validation.diagnostic.length > 0
      ? input.validation.diagnostic
      : "No diagnostic output was captured.",
    ...(input.coverage === undefined || input.coverage === null
      ? []
      : [
          `Coverage command: ${JSON.stringify(input.coverage.command)}`,
          `Coverage status: ${input.coverage.status}`,
          `Coverage exit code: ${input.coverage.exitCode === null ? "unavailable" : input.coverage.exitCode}`,
          `Coverage source snapshot: ${input.coverage.contentIdentity}`,
          "Bounded, redacted coverage diagnostics:",
          input.coverage.diagnostic.length > 0
            ? input.coverage.diagnostic
            : "No coverage diagnostic output was captured.",
          "The coverage command's exit code enforces repository-owned thresholds; do not invent or change coverage percentages.",
        ]),
    "Make only changes needed to satisfy the approved plan and fix the failing quality gates. Leave all repository changes in the worktree for orchestrator-owned validation and coverage checks.",
    "Do not run Git commands or invoke GitHub tools. Do not commit, change branches, push, or open pull requests; the orchestrator owns all Git and GitHub operations.",
  ].join("\n");
}
