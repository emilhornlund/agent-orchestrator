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
      "Please add a regression test.",
      "yarn validate",
    );

    expect(prompt).toContain("Task: Fix the parser");

    expect(prompt).toContain(
      "Pull request: https://github.com/example/repository/pull/123",
    );

    expect(prompt).toContain(
      "Human review feedback:\nPlease add a regression test.",
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
      "Please add a regression test.",
    );

    expect(prompt).toContain(
      "Run the repository's appropriate validation checks.",
    );
    expect(prompt).toContain(
      "Leave the repository validation passing before finishing.",
    );
  });
});
