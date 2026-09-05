import type { TrelloCard } from "../trello/trello-client.js";

export interface PullRequestDescriptionPromptContext {
  changedFiles: string;
  commitSha: string;
  commitMessage: string;
  validationResults: readonly string[];
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
    "Known validation or test results:",
    ...(context.validationResults.length > 0
      ? context.validationResults.map((result) => `- ${result}`)
      : [
          "- No validation or test results are available; do not infer or claim success.",
        ]),
    "",
    "Base the response only on the supplied task and the actual final repository state.",
    "Do not modify files, create commits, push anything, or open a pull request.",
    "Return exactly one JSON object and no Markdown fences, prose, or extra fields.",
    "The JSON object must have exactly these fields:",
    '- "summary": a non-blank string describing the completed implementation,',
    '- "changes": an array of non-blank strings describing the actual changes,',
    '- "validation": an array of non-blank strings describing known validation or test results.',
    "Use an empty validation array when no validation or test result is known.",
  ].join("\n");
}
