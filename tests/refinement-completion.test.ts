import { describe, expect, it, vi } from "vitest";

import type { Logger } from "../src/logging/logger.js";
import {
  addRefinementCompletionComment,
  buildRefinementCompletionComment,
} from "../src/refinement/refinement-completion.js";
import type { TrelloClient } from "../src/trello/trello-client.js";

function createResult(type: "feature" | "improvement" | "bug") {
  return {
    title: "Add inventory support",
    type,
    description: "# Add inventory support\n\nImprove inventory handling.",
  };
}

describe("refinement completion", () => {
  it.each(["feature", "improvement", "bug"] as const)(
    "builds a concise %s summary comment",
    (type) => {
      const result = createResult(type);

      expect(buildRefinementCompletionComment(result, "1 hour 5 minutes")).toBe(
        [
          "Agent Orchestrator completed refinement.",
          "",
          `Classification: ${type}`,
          "Refined task title: Add inventory support",
          "Elapsed workflow time: 1 hour 5 minutes",
        ].join("\n"),
      );
      expect(
        buildRefinementCompletionComment(result, "1 hour 5 minutes"),
      ).not.toContain("Refined task description:");
      expect(
        buildRefinementCompletionComment(result, "1 hour 5 minutes"),
      ).not.toContain(result.description);
    },
  );

  it("omits elapsed workflow time when it is unavailable", () => {
    expect(buildRefinementCompletionComment(createResult("improvement"))).toBe(
      [
        "Agent Orchestrator completed refinement.",
        "",
        "Classification: improvement",
        "Refined task title: Add inventory support",
      ].join("\n"),
    );
  });

  it("isolates summary comment delivery failures", async () => {
    const trello = {
      addComment: vi.fn().mockRejectedValue(new Error("Trello unavailable")),
    };
    const cardLog = {
      info: vi.fn(),
      error: vi.fn(),
    };

    await addRefinementCompletionComment(
      trello as unknown as TrelloClient,
      {
        id: "card-1",
        name: "Task",
        desc: "",
        idList: "working",
        idLabels: ["refinement"],
        url: "https://trello.example/card-1",
      },
      createResult("improvement"),
      cardLog as unknown as Logger,
      "5 seconds",
    );

    expect(cardLog.error).toHaveBeenCalledWith(
      "Failed to add refinement summary to Trello card: Trello unavailable",
    );
  });
});
