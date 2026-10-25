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

  const identity = {
    version: 1,
    projectId: input.projectId,
    cardId: input.card.id,
    reviewedContentIdentity: input.contentIdentity,
  };
  const passingExample = {
    ...identity,
    verdict: "pass",
    requirementAssessments: input.approvedPlan.requirements.map(
      (requirement) => ({
        requirementId: requirement.id,
        status: "satisfied",
        details: "The requested behavior is implemented.",
        evidence: ["src/example.ts", "tests/example.test.ts"],
      }),
    ),
    blockingFindings: [],
  };
  const failingExample = {
    ...identity,
    verdict: "fail",
    requirementAssessments: input.approvedPlan.requirements.map(
      (requirement, index) => ({
        requirementId: requirement.id,
        status: index === 0 ? "unsatisfied" : "satisfied",
        details:
          index === 0
            ? "The requested behavior is not implemented."
            : "The requested behavior is implemented.",
        evidence:
          index === 0 ? [] : ["src/example.ts", "tests/example.test.ts"],
      }),
    ),
    blockingFindings: [
      {
        kind: "incomplete",
        summary: "A requested behavior is incomplete.",
        detail: "The implementation does not meet this requirement.",
        location: { filePath: "src/example.ts", line: 12 },
      },
    ],
  };

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
    "Return exactly one JSON object and no markdown or surrounding text. The top-level object has exactly these fields: version (number, exactly 1), projectId (string, exactly the task identity above), cardId (string, exactly the task identity above), verdict (string enum 'pass' or 'fail'), requirementAssessments (array with exactly one assessment for every approved plan requirement and no others), blockingFindings (array), and reviewedContentIdentity (string, exactly the source identity above).",
    "Each requirementAssessments item has exactly: requirementId (string, exact approved plan requirement ID), status (string enum 'satisfied' or 'unsatisfied'), details (non-empty string explaining the assessment), and evidence (array of non-empty strings). A 'satisfied' assessment must have at least one concrete evidence item. An 'unsatisfied' assessment may use an empty evidence array.",
    "Each blockingFindings item has exactly: kind (string enum 'defect', 'incomplete', or 'contract-violation'), summary (non-empty string), detail (non-empty string), and optional location. If present, location has filePath (non-empty repository-relative string with no '..' path component) and optional line (positive integer). Do not use other finding fields.",
    "Use verdict 'pass' only when every requirement is satisfied and blockingFindings is empty. Use verdict 'fail' when any requirement is unsatisfied or there is any blocking finding. A valid 'fail' is a review verdict, not a format/parse error; report it with its complete assessments and findings for normal bounded remediation.",
    `Valid pass example:\n${JSON.stringify(passingExample, null, 2)}`,
    `Valid fail example:\n${JSON.stringify(failingExample, null, 2)}`,
    "A source location is optional when unknown; when supplied, use a repository-relative path and a positive line number if known.",
  ].join("\n");
}
