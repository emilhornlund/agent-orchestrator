import { describe, expect, it } from "vitest";

import { buildReviewFeedbackPrompt } from "../src/opencode/build-review-feedback-prompt.js";

describe("buildReviewFeedbackPrompt", () => {
  it("includes the task, pull request, and human review feedback", () => {
    const prompt = buildReviewFeedbackPrompt(
      {
        id: "card-1",
        name: "Fix the parser",
        desc: "Handle malformed input.",
        idList: "working",
        idLabels: [],
        url: "https://trello.com/c/card-1",
      },
      "https://github.com/example/repository/pull/123",
      {
        reviews: [
          {
            id: 1,
            body: "Please add a regression test.",
            author: "reviewer",
            submittedAt: "2026-01-01T10:00:00Z",
            inlineComments: [],
          },
        ],
      },
      "yarn validate",
    );

    expect(prompt).toContain("Task: Fix the parser");

    expect(prompt).toContain(
      "Pull request: https://github.com/example/repository/pull/123",
    );

    expect(prompt).toContain(
      "Human review feedback:\nReview 1 (ID: 1; reviewer: reviewer; submitted: 2026-01-01T10:00:00Z)\nReview body:\nPlease add a regression test.",
    );
    expect(prompt).toContain(
      "Inline code comments:\nNo inline code comments were returned.",
    );
    expect(prompt).toContain(
      "Run the configured repository validation command: `yarn validate` before finishing.",
    );
    expect(prompt).toContain(
      "Leave the repository validation passing before finishing.",
    );

    expect(prompt).toContain("Do not create commits.");
    expect(prompt).toContain("Do not push anything.");
  });

  it("uses generic validation instructions without a configured command", () => {
    const prompt = buildReviewFeedbackPrompt(
      {
        id: "card-1",
        name: "Fix the parser",
        desc: "Handle malformed input.",
        idList: "working",
        idLabels: [],
        url: "https://trello.com/c/card-1",
      },
      "https://github.com/example/repository/pull/123",
      {
        reviews: [
          {
            id: 1,
            body: "Please add a regression test.",
            author: "reviewer",
            submittedAt: "2026-01-01T10:00:00Z",
            inlineComments: [],
          },
        ],
      },
    );

    expect(prompt).toContain(
      "Run the repository's appropriate validation checks.",
    );
    expect(prompt).toContain(
      "Leave the repository validation passing before finishing.",
    );
  });

  it("keeps inline comments separate and omits unavailable location context", () => {
    const prompt = buildReviewFeedbackPrompt(
      {
        id: "card-1",
        name: "Fix the parser",
        desc: "Handle malformed input.",
        idList: "working",
        idLabels: [],
        url: "https://trello.com/c/card-1",
      },
      "https://github.com/example/repository/pull/123",
      {
        reviews: [
          {
            id: 1,
            body: null,
            author: "reviewer",
            submittedAt: "2026-01-01T10:00:00Z",
            inlineComments: [
              {
                author: "reviewer",
                body: "Please update this moved code.",
                originalLine: 27,
              },
              {
                author: "reviewer",
                body: "Please inspect this comment.",
              },
            ],
          },
        ],
      },
    );

    expect(prompt).toContain("Review body:\nNo review body was returned.");
    expect(prompt).toContain(
      "Inline code comments:\nreviewer [original line 27]: Please update this moved code.\nreviewer: Please inspect this comment.",
    );
    expect(prompt).not.toContain("line undefined");
    expect(prompt).not.toContain("Diff context:");
    expect(prompt).not.toContain("[file");
  });

  it("renders every review with attribution and clear boundaries", () => {
    const prompt = buildReviewFeedbackPrompt(
      {
        id: "card-1",
        name: "Fix the parser",
        desc: "Handle malformed input.",
        idList: "working",
        idLabels: [],
        url: "https://trello.com/c/card-1",
      },
      "https://github.com/example/repository/pull/123",
      {
        reviews: [
          {
            id: 12,
            body: "Please handle null values.",
            author: "reviewer-one",
            submittedAt: "2026-01-01T10:00:00Z",
            inlineComments: [
              {
                author: "reviewer-one",
                body: "Cover this branch.",
                path: "src/parser.ts",
                line: 10,
              },
            ],
          },
          {
            id: 34,
            body: "Please document the behavior.",
            author: "reviewer-two",
            submittedAt: "2026-01-02T10:00:00Z",
            inlineComments: [],
          },
        ],
      },
    );

    expect(prompt).toContain(
      "Review 1 (ID: 12; reviewer: reviewer-one; submitted: 2026-01-01T10:00:00Z)",
    );
    expect(prompt).toContain("Please handle null values.");
    expect(prompt).toContain(
      "reviewer-one [src/parser.ts, line 10]: Cover this branch.",
    );
    expect(prompt).toContain(
      "Review 2 (ID: 34; reviewer: reviewer-two; submitted: 2026-01-02T10:00:00Z)",
    );
    expect(prompt).toContain("Please document the behavior.");
  });

  it("labels carried-forward inline feedback separately from current-head feedback", () => {
    const prompt = buildReviewFeedbackPrompt(
      {
        id: "card-1",
        name: "Fix the parser",
        desc: "Handle malformed input.",
        idList: "working",
        idLabels: [],
        url: "https://trello.com/c/card-1",
      },
      "https://github.com/example/repository/pull/123",
      {
        reviews: [
          {
            id: 12,
            body: null,
            author: "reviewer",
            submittedAt: "2026-01-01T10:00:00Z",
            source: "carried-forward",
            inlineComments: [
              {
                body: "Still fix this.",
                author: "reviewer",
                threadId: "thread-1",
                source: "carried-forward",
                path: "src/parser.ts",
                line: 10,
              },
            ],
          },
        ],
      },
    );

    expect(prompt).toContain(
      "Review 1 (ID: 12; reviewer: reviewer; submitted: 2026-01-01T10:00:00Z; source: carried-forward unresolved inline feedback)",
    );
    expect(prompt).toContain(
      "reviewer [src/parser.ts, line 10]: Still fix this.",
    );
  });
});
