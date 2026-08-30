import { describe, expect, it } from "vitest";

import { buildRefinementPrompt } from "../src/opencode/build-refinement-prompt.js";
import { refinementResultRelativePath } from "../src/refinement/refinement-result.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

function createCard(overrides: Partial<TrelloCard> = {}): TrelloCard {
  return {
    id: "card-123",
    name: "Inventory thing",
    desc: "Players need some kind of inventory support.",
    idList: "working-list",
    idLabels: ["refinement-label"],
    url: "https://trello.example/card-123",
    ...overrides,
  };
}

describe("buildRefinementPrompt", () => {
  it("includes the original Trello task", () => {
    const prompt = buildRefinementPrompt(createCard());

    expect(prompt).toContain("Original title: Inventory thing");
    expect(prompt).toContain(
      "Original description:\nPlayers need some kind of inventory support.",
    );
  });

  it("handles cards without a description", () => {
    const prompt = buildRefinementPrompt(
      createCard({
        desc: "   ",
      }),
    );

    expect(prompt).toContain("No original task description was provided.");
  });

  it("requires exactly one supported task classification", () => {
    const prompt = buildRefinementPrompt(createCard());

    expect(prompt).toContain("Classify the task as exactly one of:");
    expect(prompt).toContain("- feature");
    expect(prompt).toContain("- improvement");
    expect(prompt).toContain("- bug");
  });

  it("requires the dedicated JSON result artifact", () => {
    const prompt = buildRefinementPrompt(createCard());

    expect(prompt).toContain(refinementResultRelativePath);
    expect(prompt).toContain('"type": "feature | improvement | bug"');
    expect(prompt).toContain(
      "The file must contain valid JSON, not a Markdown code fence.",
    );
    expect(prompt).toContain(
      "Do not use the agent response text as the refinement result.",
    );
  });

  it("forbids implementation and repository mutations", () => {
    const prompt = buildRefinementPrompt(createCard());

    expect(prompt).toContain("Do not modify repository implementation files.");
    expect(prompt).toContain(
      "Do not modify tests, documentation, configuration, or other repository files.",
    );
    expect(prompt).toContain("Do not create commits.");
    expect(prompt).toContain("Do not create branches.");
    expect(prompt).toContain("Do not push anything.");
    expect(prompt).toContain("Do not create or modify pull requests.");
  });

  it("includes all three task templates", () => {
    const prompt = buildRefinementPrompt(createCard());

    expect(prompt).toContain("Feature template:");
    expect(prompt).toContain("# <Feature Title>");
    expect(prompt).toContain(
      "Implement <feature or capability> so that <user, developer, or system benefit>.",
    );

    expect(prompt).toContain("Improvement template:");
    expect(prompt).toContain("# <Improvement Title>");
    expect(prompt).toContain(
      "Improve <existing component, workflow, or behavior> by <briefly describe the desired improvement>.",
    );

    expect(prompt).toContain("Bug template:");
    expect(prompt).toContain("# <Bug Title>");
    expect(prompt).toContain("## Reproduction");
    expect(prompt).toContain("## Expected Behavior");

    expect(prompt).toContain(
      "Run the repository's appropriate validation checks successfully before considering the task complete.",
    );
  });

  it("tells the agent not to invent or expand requirements", () => {
    const prompt = buildRefinementPrompt(createCard());

    expect(prompt).toContain(
      "Do not expand the task into unrelated work or speculative improvements.",
    );
    expect(prompt).toContain(
      "Do not invent requirements that are unsupported by either the original task or repository evidence.",
    );
  });

  it("distinguishes refinement from eventual implementation validation", () => {
    const prompt = buildRefinementPrompt(createCard());

    expect(prompt).toContain(
      "The validation instructions inside the templates describe requirements for the eventual implementation task.",
    );
    expect(prompt).toContain(
      "They do not authorize you to implement the task during this refinement session.",
    );
  });
});
