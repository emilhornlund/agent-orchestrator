import { describe, expect, it } from "vitest";

import { buildCommitMessage } from "../src/git/build-commit-message.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

function createCard(name: string): TrelloCard {
  return {
    id: "card-123",
    name,
    desc: "",
    idList: "working",
    url: "https://trello.example/card-123",
  };
}

describe("buildCommitMessage", () => {
  it("uses the Trello card title", () => {
    expect(buildCommitMessage(createCard("Add player inventory"))).toBe(
      "Add player inventory",
    );
  });

  it("normalizes whitespace", () => {
    expect(buildCommitMessage(createCard("Add   player\ninventory"))).toBe(
      "Add player inventory",
    );
  });

  it("limits the commit subject length", () => {
    const message = buildCommitMessage(createCard("A".repeat(100)));

    expect(message.length).toBeLessThanOrEqual(72);
    expect(message.endsWith("...")).toBe(true);
  });
});
