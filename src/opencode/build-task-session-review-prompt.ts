import {
  buildCardAttachmentPromptLines,
  type CardAttachmentPromptContext,
} from "../context/card-attachment-prompt.js";
import type { TaskSessionValidationResult } from "../task-session/run-task-session-validation.js";
import type { TaskPlan } from "../task-session/task-plan.js";
import type { TrelloCard } from "../trello/trello-client.js";

export interface TaskSessionReviewDiff {
  staged: string;
  unstaged: string;
  untracked: readonly {
    path: string;
    encoding: "utf8" | "base64" | "symlink";
    content: string;
  }[];
}

export interface BuildTaskSessionReviewPromptInput {
  projectId: string;
  card: TrelloCard;
  approvedPlan: TaskPlan;
  contentIdentity: string;
  diff: TaskSessionReviewDiff;
  validation: TaskSessionValidationResult;
  coverage: TaskSessionValidationResult | null;
  attachmentContext?: CardAttachmentPromptContext;
}

export function buildTaskSessionReviewPrompt(
  input: BuildTaskSessionReviewPromptInput,
): string {
  if (
    input.approvedPlan.projectId !== input.projectId ||
    input.approvedPlan.cardId !== input.card.id
  ) {
    throw new Error(
      "Approved task plan does not match the implementation review identity",
    );
  }

  if (
    input.attachmentContext !== undefined &&
    (input.attachmentContext.projectId !== input.projectId ||
      input.attachmentContext.cardId !== input.card.id)
  ) {
    throw new Error(
      "Review attachment context does not match the task project and card",
    );
  }

  return [
    "Independently review the implementation for completeness and correctness. This is a read-only review; do not implement, edit files, run commands, or perform Git/GitHub actions.",
    "",
    `Task identity: ${JSON.stringify({ projectId: input.projectId, cardId: input.card.id })}`,
    `Original task title: ${JSON.stringify(input.card.name)}`,
    "Original task description:",
    input.card.desc.trim().length > 0
      ? input.card.desc
      : "No additional description was provided.",
    ...buildCardAttachmentPromptLines(input.attachmentContext),
    "Approved plan and acceptance criteria:",
    JSON.stringify(input.approvedPlan, null, 2),
    `Reviewed source content identity: ${input.contentIdentity}`,
    "Current source changes, including staged, unstaged, and untracked files:",
    JSON.stringify(input.diff, null, 2),
    "Orchestrator-owned quality evidence:",
    JSON.stringify(
      {
        validation: input.validation,
        coverage: input.coverage,
      },
      null,
      2,
    ),
    "Assess every approved plan requirement exactly once. Identify missing requested behavior, unsupported or invented scope, serious correctness defects, and repository contract violations. The successful agent process exit is not evidence that requirements are satisfied.",
    "Return only a JSON object matching the required implementation review result schema: version, projectId, cardId, verdict ('pass' or 'fail'), requirementAssessments, blockingFindings, and reviewedContentIdentity. Every satisfied requirement must include concrete evidence. Use fail with a concrete finding for any unmet requirement or serious defect.",
    "A source location is optional when unknown; when supplied, use a repository-relative path and a positive line number if known.",
  ].join("\n");
}
