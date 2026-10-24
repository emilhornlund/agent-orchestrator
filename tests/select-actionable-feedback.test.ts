import { describe, expect, it } from "vitest";
import type {
  PullRequestConversationComment,
  PullRequestReview,
} from "../src/github/github-client.js";
import { selectActionableFeedback } from "../src/task-session/select-actionable-feedback.js";

const head = "a".repeat(40);
const review = (
  overrides: Partial<PullRequestReview> = {},
): PullRequestReview => ({
  id: 10,
  body: "Please fix the current implementation.",
  author: "reviewer",
  submittedAt: "2026-10-24T09:00:00.000Z",
  commitSha: head,
  inlineComments: [
    {
      id: 100,
      reviewId: 10,
      body: "Open thread",
      author: "reviewer",
      isResolved: false,
      isOutdated: false,
      threadId: "thread-1",
    },
    {
      id: 101,
      body: "Resolved",
      author: "reviewer",
      isResolved: true,
      isOutdated: false,
    },
    {
      id: 102,
      body: "Outdated",
      author: "reviewer",
      isResolved: false,
      isOutdated: true,
    },
  ],
  ...overrides,
});
const conversation = (
  id: number,
  author = "reviewer",
): PullRequestConversationComment => ({
  id,
  author,
  createdAt: "2026-10-24T09:00:00.000Z",
  updatedAt: null,
  body: `comment-${id}`,
});

describe("selectActionableFeedback", () => {
  it("selects current requested-change reviews and applicable unresolved inline requests", () => {
    const selection = selectActionableFeedback({
      currentHeadSha: head,
      botAuthor: "agent[bot]",
      reviews: [review()],
      conversationComments: [],
    });
    expect(selection.actionable.map(({ key }) => key)).toEqual([
      "review:10",
      "inline-comment:100",
    ]);
    expect(selection.actionable[1]).toMatchObject({
      reviewId: "10",
      threadId: "thread-1",
    });
    expect(selection.attentionNeeded).toEqual([]);
  });

  it("carries applicable old-head inline requests, but flags unknown thread state and stale reviews", () => {
    const carried = review({
      id: 11,
      body: null,
      commitSha: "b".repeat(40),
      source: "carried-forward",
      inlineComments: [
        {
          id: 110,
          body: "Still unresolved",
          author: "reviewer",
          isResolved: false,
          isOutdated: false,
        },
        { id: 111, body: "Unknown state", author: "reviewer" },
      ],
    });
    const stale = review({ id: 12, commitSha: "c".repeat(40) });
    const result = selectActionableFeedback({
      currentHeadSha: head,
      botAuthor: "agent[bot]",
      reviews: [carried, stale],
      conversationComments: [],
    });
    expect(result.actionable.map(({ key }) => key)).toEqual([
      "inline-comment:110",
    ]);
    expect(result.attentionNeeded).toHaveLength(2);
  });

  it("keeps general comments for classification and ignores bot-authored replies", () => {
    const result = selectActionableFeedback({
      currentHeadSha: head,
      botAuthor: "agent[bot]",
      reviews: [],
      conversationComments: [
        conversation(1),
        conversation(2, "agent[bot]"),
        conversation(3),
      ],
      conversationClassifications: { "conversation-comment:3": "actionable" },
    });
    expect(result.actionable.map(({ key }) => key)).toEqual([
      "conversation-comment:3",
    ]);
    expect(result.discussion.map(({ id }) => id)).toEqual([1]);
    expect(result.attentionNeeded.map(({ feedbackId }) => feedbackId)).toEqual([
      "conversation-comment:1",
    ]);
  });
});
