import { describe, expect, it } from "vitest";

import { enrichPullRequestDescription } from "../src/github/enrich-pull-request-description.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

const card: TrelloCard = {
  id: "card-1",
  name: "Example task",
  desc: "",
  idList: "review",
  idLabels: [],
  url: "https://trello.com/c/card-1",
};
const fallback = [
  `Trello: ${card.url}`,
  "",
  "Implemented automatically by Agent Orchestrator Bot.",
].join("\n");
const generated = [
  "<!-- agent-orchestrator-description:start -->",
  "## Summary",
  "A completed change.",
  "<!-- agent-orchestrator-description:end -->",
  "\n\n## Task",
  `[Trello card: ${card.name}](${card.url})`,
  "\n\nImplemented automatically by Agent Orchestrator Bot.",
  "\n\n<!-- agent-orchestrator-status:start -->\n<!-- agent-orchestrator-status:end -->",
].join("\n");

describe("enrichPullRequestDescription", () => {
  it("migrates the exact recognized static fallback", () => {
    expect(
      enrichPullRequestDescription(
        fallback,
        generated,
        card,
        "Agent Orchestrator Bot",
      ),
    ).toBe(generated);
  });

  it("updates only marked content and preserves human edits and status markers", () => {
    const humanText = `Human note\n\n${generated}\n\nPlease keep this section.`;
    const updatedGenerated = generated.replace(
      "A completed change.",
      "An updated change.",
    );
    const enriched = enrichPullRequestDescription(
      humanText,
      updatedGenerated,
      card,
      "Agent Orchestrator Bot",
    );
    expect(enriched).toContain("Human note");
    expect(enriched).toContain("Please keep this section.");
    expect(enriched).toContain("An updated change.");
    expect(enriched).toContain("<!-- agent-orchestrator-status:start -->");
  });

  it("is idempotent and refuses unknown human-authored descriptions", () => {
    expect(
      enrichPullRequestDescription(
        generated,
        generated,
        card,
        "Agent Orchestrator Bot",
      ),
    ).toBe(generated);
    expect(
      enrichPullRequestDescription(
        `${fallback}\n\nHuman edit`,
        generated,
        card,
        "Agent Orchestrator Bot",
      ),
    ).toBeNull();
  });
});
