import { describe, expect, it, vi } from "vitest";

import type { Logger } from "../src/logging/logger.js";
import {
  addRefinementCompletionComment,
  buildRefinementCompletionComment,
} from "../src/refinement/refinement-completion.js";
import type { TrelloClient } from "../src/trello/trello-client.js";

const result = {
  title: "Add inventory support",
  type: "improvement" as const,
  description: "# Add inventory support\n\nImprove inventory handling.",
};

describe("refinement completion", () => {
  it("builds a summary comment with the classification and refined task", () => {
    expect(buildRefinementCompletionComment(result)).toBe(
      [
        "Agent Orchestrator completed refinement.",
        "",
        "Classification: improvement",
        "Refined task title: Add inventory support",
        "",
        "Refined task description:",
        "# Add inventory support\n\nImprove inventory handling.",
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
      result,
      cardLog as unknown as Logger,
    );

    expect(cardLog.error).toHaveBeenCalledWith(
      "Failed to add refinement summary to Trello card: Trello unavailable",
    );
  });
});
