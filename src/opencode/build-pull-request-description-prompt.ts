import type { TrelloCard } from "../trello/trello-client.js";

import {
  MAX_PULL_REQUEST_DESCRIPTION_CHANGES,
  MAX_PULL_REQUEST_DESCRIPTION_ITEM_LENGTH,
  MAX_PULL_REQUEST_DESCRIPTION_SUMMARY_LENGTH,
  MAX_PULL_REQUEST_DESCRIPTION_VALIDATION,
} from "./pull-request-description.js";

export interface PullRequestDescriptionPromptContext {
  changedFiles: string;
  commitSha: string;
  commitMessage: string;
  validationCommand?: string;
  workflowResults: readonly string[];
}

export function buildPullRequestDescriptionPrompt(
  card: TrelloCard,
  context: PullRequestDescriptionPromptContext,
): string {
  const description = card.desc.trim();
  const changedFiles = context.changedFiles.trim();
  const commitMessage = context.commitMessage.trim();

  return [
    "Describe the completed implementation for a future pull request.",
    "",
    `Trello card title: ${card.name}`,
    description.length > 0
      ? `Trello card description:\n${description}`
      : "Trello card description: No additional task description was provided.",
    `Trello card URL: ${card.url}`,
    "",
    "Final changed files:",
    changedFiles.length > 0 ? changedFiles : "Unavailable; do not infer files.",
    "",
    `Resulting commit SHA: ${context.commitSha}`,
    commitMessage.length > 0
      ? `Commit message:\n${commitMessage}`
      : "Commit message: Unavailable; do not invent commit details.",
    "",
    "Validation evidence captured by the orchestrator:",
    "- None; validation execution was delegated to modifying OpenCode sessions, and the orchestrator did not observe its result. Do not infer or claim success.",
    "Validation command supplied to modifying OpenCode sessions:",
    context.validationCommand === undefined
      ? "- No validation command was configured."
      : `- Configured validation command \`${context.validationCommand}\` was supplied to modifying OpenCode sessions, but the orchestrator did not execute it; its result is unavailable. This does not establish that validation passed.`,
    "Workflow outcomes (separate from validation evidence):",
    ...context.workflowResults.map((result) => `- ${result}`),
    "",
    "Base the response only on the supplied task and the actual final repository state.",
    "Do not modify files, create commits, push anything, or open a pull request.",
    "Return exactly one JSON object.",
    "Do not include an introduction, explanation, Markdown, code fences, or any text before or after the JSON object.",
    "The response must start with { and end with }.",
    "Do not return any prose or extra fields.",
    "The JSON object must have exactly these fields:",
    '- "summary": a non-blank string describing the completed implementation,',
    '- "changes": an array of non-blank strings describing the actual changes,',
    '- "validation": an array of non-blank strings describing validation or test results independently known to the orchestrator.',
    `The summary must be at most ${MAX_PULL_REQUEST_DESCRIPTION_SUMMARY_LENGTH} characters; changes and validation may each contain at most ${MAX_PULL_REQUEST_DESCRIPTION_CHANGES} and ${MAX_PULL_REQUEST_DESCRIPTION_VALIDATION} items respectively, and every item must be at most ${MAX_PULL_REQUEST_DESCRIPTION_ITEM_LENGTH} characters.`,
    "Use an empty validation array because the orchestrator has no independently captured validation or test result.",
  ].join("\n");
}
