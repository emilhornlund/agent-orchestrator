import { describe, expect, it } from "vitest";

import { buildReviewPrompt } from "../src/opencode/build-review-prompt.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

function createCard(desc = "Implement the requested feature."): TrelloCard {
  return {
    id: "card-1",
    name: "Example task",
    desc,
  } as TrelloCard;
}

describe("buildReviewPrompt", () => {
  it("limits REVIEW_FAIL to critical or high-severity defects", () => {
    const prompt = buildReviewPrompt(createCard());

    expect(prompt).toContain(
      "Return REVIEW_FAIL only when you find at least one concrete critical or high-severity issue.",
    );

    expect(prompt).toContain(
      "Do NOT return REVIEW_FAIL for minor or moderate concerns.",
    );

    expect(prompt).toContain("Do NOT require perfection.");

    expect(prompt).toContain(
      "When uncertain whether an issue is truly critical/high severity, treat it as non-blocking and return REVIEW_PASS.",
    );

    expect(prompt).toContain(
      "Use REVIEW_PASS even if there are minor, moderate, advisory, stylistic, or optional findings.",
    );
  });

  it("includes the task description", () => {
    const prompt = buildReviewPrompt(
      createCard("Preserve backwards compatibility."),
    );

    expect(prompt).toContain("Task: Example task");
    expect(prompt).toContain("Description:\nPreserve backwards compatibility.");
  });

  it("handles an empty task description", () => {
    const prompt = buildReviewPrompt(createCard("   "));

    expect(prompt).toContain("No additional task description was provided.");
  });
});
