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
      "yarn validate",
    );

    expect(prompt).toContain("Task: Fix player movement");
    expect(prompt).toContain("Movement can exceed the configured speed.");
    expect(prompt).toContain(
      "Run the configured repository validation command: `yarn validate` before finishing.",
    );
    expect(prompt).toContain(
      "Leave the repository validation passing before finishing.",
    );
    expect(prompt).toContain("Do not create commits.");
  });

  it("uses generic validation instructions without a configured command", () => {
    const prompt = buildRemediationPrompt(
      {
        id: "card-123",
        name: "Fix player movement",
        desc: "",
        idList: "working",
        url: "https://trello.example/card-123",
      },
      "Movement can exceed the configured speed.",
    );

    expect(prompt).toContain(
      "Run the repository's appropriate validation checks.",
    );
    expect(prompt).toContain(
      "Leave the repository validation passing before finishing.",
    );
  });
});
