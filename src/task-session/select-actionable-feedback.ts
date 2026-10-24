import type {
  InlineReviewComment,
  PullRequestConversationComment,
  PullRequestReview,
} from "../github/github-client.js";

export type ConversationClassification =
  "actionable" | "discussion" | "not-actionable";

export interface SelectedFeedbackItem {
  key: string;
  kind: "review" | "inline-comment" | "conversation-comment";
  id: string;
  author: string | null;
  body: string;
  commitSha?: string;
  reviewId?: string;
  path?: string;
  line?: number;
  threadId?: string;
}

export interface FeedbackSelection {
  actionable: SelectedFeedbackItem[];
  discussion: PullRequestConversationComment[];
  attentionNeeded: Array<{ feedbackId: string; reason: string }>;
}

export interface SelectActionableFeedbackInput {
  currentHeadSha: string;
  botAuthor: string;
  reviews: readonly PullRequestReview[];
  conversationComments: readonly PullRequestConversationComment[];
  conversationClassifications?: Readonly<
    Record<string, ConversationClassification>
  >;
}

function nonBlank(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.trim().length > 0;
}

function inlineItem(
  review: PullRequestReview,
  comment: InlineReviewComment,
): SelectedFeedbackItem | null {
  if (comment.isResolved === true || comment.isOutdated === true) return null;
  const reviewId = comment.reviewId ?? review.id;
  if (comment.id === undefined) return null;
  return {
    key: `inline-comment:${comment.id}`,
    kind: "inline-comment",
    id: String(comment.id),
    author: comment.author,
    body: comment.body,
    ...(comment.commitSha === undefined
      ? review.commitSha === undefined
        ? {}
        : { commitSha: review.commitSha }
      : { commitSha: comment.commitSha }),
    ...(comment.path === undefined ? {} : { path: comment.path }),
    ...(comment.line === undefined ? {} : { line: comment.line }),
    ...(comment.threadId === undefined ? {} : { threadId: comment.threadId }),
    reviewId: String(reviewId),
  };
}

export function selectActionableFeedback(
  input: SelectActionableFeedbackInput,
): FeedbackSelection {
  const actionable: SelectedFeedbackItem[] = [];
  const discussion: PullRequestConversationComment[] = [];
  const attentionNeeded: FeedbackSelection["attentionNeeded"] = [];

  for (const review of input.reviews) {
    const carried = review.source === "carried-forward";
    if (!carried && review.commitSha !== input.currentHeadSha) {
      attentionNeeded.push({
        feedbackId: `review:${review.id}`,
        reason: "Review commit does not match the current PR head",
      });
      continue;
    }

    if (nonBlank(review.body)) {
      actionable.push({
        key: `review:${review.id}`,
        kind: "review",
        id: String(review.id),
        author: review.author,
        body: review.body,
        ...(review.commitSha === undefined
          ? {}
          : { commitSha: review.commitSha }),
      });
    }

    for (const comment of review.inlineComments) {
      if (comment.isResolved === true || comment.isOutdated === true) continue;
      if (
        carried &&
        (comment.isResolved === undefined || comment.isOutdated === undefined)
      ) {
        attentionNeeded.push({
          feedbackId:
            comment.id === undefined
              ? `review:${review.id}`
              : `inline-comment:${comment.id}`,
          reason: "Carried-forward inline thread resolution state is unknown",
        });
        continue;
      }
      const item = inlineItem(review, comment);
      if (item === null) {
        attentionNeeded.push({
          feedbackId: `review:${review.id}`,
          reason: "Applicable inline feedback has no stable comment ID",
        });
        continue;
      }
      actionable.push(item);
    }
  }

  for (const comment of input.conversationComments) {
    if (comment.author === input.botAuthor) continue;
    const key = `conversation-comment:${comment.id}`;
    const classification = input.conversationClassifications?.[key];
    if (classification === "actionable") {
      actionable.push({
        key,
        kind: "conversation-comment",
        id: String(comment.id),
        author: comment.author,
        body: comment.body,
        ...(comment.commitSha === undefined
          ? {}
          : { commitSha: comment.commitSha }),
      });
    } else {
      discussion.push(comment);
      if (classification === undefined) {
        attentionNeeded.push({
          feedbackId: key,
          reason:
            "Conversation comment requires explicit actionability classification",
        });
      }
    }
  }

  return { actionable, discussion, attentionNeeded };
}
