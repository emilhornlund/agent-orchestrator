import type { TrelloCard } from "../trello/trello-client.js";

export function buildCommitPrompt(card: TrelloCard): string {
  return [
    "Commit the final reviewed changes for this task.",
    "",
    `Task: ${card.name}`,
    "",
    "Inspect the complete Git status and diff before committing.",
    "Stage all intended task changes, including additions, modifications, and deletions.",
    "Create exactly one commit.",
    "Do not modify implementation files.",
    "Do not push anything.",
    "",
    "When creating a multiline commit message, preserve real line breaks.",
    "Do not encode line breaks as literal \\n sequences in git command arguments.",
    "Prefer a temporary commit-message file or another shell-safe method that preserves the message exactly.",
    "After committing, inspect the final commit message with `git log -1 --format=%B`.",
    "If the message contains literal \\n text or does not match the required format, amend that same commit to correct the message.",
    "",
    "Use this commit-message format:",
    "",
    "type(scope): summary",
    "",
    "- Bullet point 1.",
    "- Bullet point 2.",
    "",
    "Final sentence describing the overall impact.",
    "",
    "Choose the appropriate Conventional Commit type such as feat, fix, refactor, docs, test, build, ci, or chore.",
    "Base the message on the actual final changes.",
    "Do not include AI attribution.",
  ].join("\n");
}
