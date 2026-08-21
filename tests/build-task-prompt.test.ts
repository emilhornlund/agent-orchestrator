import { describe, expect, it } from "vitest";

import { buildTaskPrompt } from "../src/opencode/build-task-prompt.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

describe("buildTaskPrompt", () => {
  it("includes the Trello card title and description", () => {
    const card: TrelloCard = {
      id: "card-123",
      name: "Add player inventory",
      desc: "Create an inventory component for the player.",
      idList: "working",
      url: "https://trello.example/card-123",
    };

    const prompt = buildTaskPrompt(card);

    expect(prompt).toContain("Task: Add player inventory");
    expect(prompt).toContain("Create an inventory component for the player.");
    expect(prompt).toContain(
      "Do not create commits, push branches, or open pull requests.",
    );
  });

  it("handles an empty description", () => {
    const card: TrelloCard = {
      id: "card-123",
      name: "Fix player movement",
      desc: "",
      idList: "working",
      url: "https://trello.example/card-123",
    };

    const prompt = buildTaskPrompt(card);

    expect(prompt).toContain("No additional task description was provided.");
  });
});
