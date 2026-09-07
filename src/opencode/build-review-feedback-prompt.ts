import type { TrelloCard } from "../trello/trello-client.js";
import type {
  InlineReviewComment,
  PullRequestReviewFeedback,
} from "../github/github-client.js";
import {
  buildCardAttachmentPromptLines,
  type CardAttachmentPromptContext,
} from "../context/card-attachment-prompt.js";

export function buildReviewFeedbackPrompt(
  card: TrelloCard,
  pullRequestUrl: string,
  feedback: PullRequestReviewFeedback | string,
  validationCommand?: string,
  attachmentContext?: CardAttachmentPromptContext,
): string {
  const reviewFeedback: PullRequestReviewFeedback =
    typeof feedback === "string"
      ? { general: feedback.trim(), inlineComments: [] }
      : feedback;

  return [
    "Apply the human review feedback for the existing pull request.",
    "",
    `Task: ${card.name}`,
    `Pull request: ${pullRequestUrl}`,
    "",
    "Human review feedback:",
    "General PR-level feedback:",
    reviewFeedback.general ??
      (reviewFeedback.inlineComments.length === 0
        ? "Changes were requested on GitHub, but no written review feedback was returned."
        : "No general PR-level feedback was returned."),
    "",
    "Inline code comments:",
    ...(reviewFeedback.inlineComments.length > 0
      ? reviewFeedback.inlineComments.flatMap(formatInlineReviewComment)
      : ["No inline code comments were returned."]),
    ...buildCardAttachmentPromptLines(attachmentContext),
    "",
    "Inspect the current repository and existing implementation before editing.",
    "Address all still-applicable requested changes completely.",
    "Some feedback may refer to code that has already changed, so verify the current state before modifying it.",
    "Keep the existing task scope unless the review feedback explicitly requires otherwise.",
    ...(validationCommand
      ? [
          `Run the configured repository validation command: \`${validationCommand}\` before finishing.`,
        ]
      : ["Run the repository's appropriate validation checks."]),
    "Leave the repository validation passing before finishing.",
    "Do not create commits.",
    "Do not push anything.",
    "Do not open pull requests.",
  ].join("\n");
}

function formatInlineReviewComment(comment: InlineReviewComment): string[] {
  const locationParts: string[] = [];

  if (comment.path !== undefined) {
    locationParts.push(comment.path);
  }

  if (comment.line !== undefined) {
    locationParts.push(`line ${comment.line}`);
  }

  if (comment.originalLine !== undefined) {
    locationParts.push(`original line ${comment.originalLine}`);
  }

  const location =
    locationParts.length > 0 ? ` [${locationParts.join(", ")}]` : "";
  const lines = [`${comment.author ?? "reviewer"}${location}: ${comment.body}`];

  if (comment.diffHunk !== undefined && comment.diffHunk.length > 0) {
    lines.push(`Diff context:\n${comment.diffHunk}`);
  }

  return lines;
}
