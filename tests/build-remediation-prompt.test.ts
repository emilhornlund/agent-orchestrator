import { describe, expect, it } from "vitest";

import { buildRemediationPrompt } from "../src/opencode/build-remediation-prompt.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

describe("buildRemediationPrompt", () => {
  it("includes the task and review findings", () => {
    const card: TrelloCard = {
      id: "card-123",
      name: "Fix player movement",
      desc: "",
      idList: "working",
      url: "https://trello.example/card-123",
    };

    const prompt = buildRemediationPrompt(
      card,
      "Movement can exceed the configured speed.\nREVIEW_FAIL",
    );

    expect(prompt).toContain("Task: Fix player movement");
    expect(prompt).toContain("Movement can exceed the configured speed.");
    expect(prompt).toContain("Do not create commits.");
  });
});
