import { describe, expect, it } from "vitest";

import { buildCommitPrompt } from "../src/opencode/build-commit-prompt.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

describe("buildCommitPrompt", () => {
  it("includes the task and commit rules", () => {
    const card: TrelloCard = {
      id: "card-123",
      name: "Add player inventory",
      desc: "",
      idList: "working",
      idLabels: [],
      url: "https://trello.example/card-123",
    };

    const prompt = buildCommitPrompt(card);

    expect(prompt).toContain("Task: Add player inventory");
    expect(prompt).toContain("type(scope): summary");
    expect(prompt).toContain("Do not create or amend commits.");
    expect(prompt).toContain("Do not push anything.");
    expect(prompt).toContain("Do not include AI attribution.");
  });

  it("requires a structured artifact with real multiline messages", () => {
    const card: TrelloCard = {
      id: "card-123",
      name: "Add player inventory",
      desc: "",
      idList: "working",
      idLabels: [],
      url: "https://trello.example/card-123",
    };

    const prompt = buildCommitPrompt(card);

    expect(prompt).toContain(
      "Write exactly one JSON object to .agent-orchestrator/commit-result.json.",
    );
    expect(prompt).toContain(
      "The artifact is the only permitted repository write.",
    );
    expect(prompt).toContain("Do not stage files.");
    expect(prompt).toContain("preserve real line breaks");
  });
});
