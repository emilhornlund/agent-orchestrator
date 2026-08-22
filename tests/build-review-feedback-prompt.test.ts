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
        url: "https://trello.com/c/card-1",
      },
      "https://github.com/example/repository/pull/123",
      "Please add a regression test.",
    );

    expect(prompt).toContain("Task: Fix the parser");

    expect(prompt).toContain(
      "Pull request: https://github.com/example/repository/pull/123",
    );

    expect(prompt).toContain(
      "Human review feedback:\nPlease add a regression test.",
    );

    expect(prompt).toContain("Do not create commits.");
    expect(prompt).toContain("Do not push anything.");
  });
});
