import { describe, expect, it } from "vitest";

import { buildTaskSessionCiRepairPrompt } from "../src/opencode/build-task-session-ci-repair-prompt.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

const card: TrelloCard = {
  id: "card-one",
  name: "Repair export output",
  desc: "Export the requested data in the task worktree.",
  idList: "review",
  idLabels: [],
  url: "https://trello.example/card-one",
};

describe("buildTaskSessionCiRepairPrompt", () => {
  it("uses the original task scope when no plan was available", () => {
    const prompt = buildTaskSessionCiRepairPrompt({
      projectId: "project-one",
      card,
      headSha: "a".repeat(40),
      attempt: 1,
      maxAttempts: 2,
      diagnostics: [
        {
          name: "Build",
          headSha: "a".repeat(40),
          logUrl: null,
          available: true,
          diagnostic: "Build failed in the export module.",
        },
      ],
    });

    expect(prompt).toContain("No usable plan was available.");
    expect(prompt).toContain(card.desc);
    expect(prompt).toContain("preserving the original task scope");
    expect(prompt).not.toContain("Approved plan:");
  });
});
