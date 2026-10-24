import { describe, expect, it } from "vitest";

import { buildTaskPlanningPrompt } from "../src/opencode/build-task-planning-prompt.js";
import { buildTaskSessionImplementationPrompt } from "../src/opencode/build-task-session-implementation-prompt.js";
import type { TaskPlan } from "../src/task-session/task-plan.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

const projectId = "project-one";
const card: TrelloCard = {
  id: "card-one",
  name: "Implement the requested feature",
  desc: "Implement the behavior described by the task.",
  idList: "ready-list",
  idLabels: [],
  url: "https://trello.example/card-one",
};
const approvedPlan: TaskPlan = {
  version: 1,
  projectId,
  cardId: card.id,
  requirements: [
    {
      id: "REQ-1",
      text: "Implement the requested behavior.",
      verification: "Add and run a focused test.",
    },
  ],
  steps: [
    {
      id: "STEP-1",
      description: "Implement the behavior and its test.",
      requirementIds: ["REQ-1"],
      verification: "Run the focused test suite.",
    },
  ],
  assumptions: [],
  blockers: [],
};

const prompts = [
  buildTaskPlanningPrompt(projectId, card),
  buildTaskSessionImplementationPrompt({ projectId, card, approvedPlan }),
];

describe("task-session repository prompt guidance", () => {
  it.each(prompts)(
    "requires repository instructions and native skill discovery",
    (prompt) => {
      expect(prompt).toContain("repository-root AGENTS.md");
      expect(prompt).toContain("more-specific AGENTS.md");
      expect(prompt).toContain(".opencode/skills/");
      expect(prompt).toContain("native skill mechanism");
    },
  );

  it.each(prompts)(
    "has an offline fallback when no skill is available",
    (prompt) => {
      expect(prompt).toContain(
        "If no relevant repository-local skill is available",
      );
      expect(prompt).toContain("do not download or install skills");
      expect(prompt).toContain("or use external/global skills");
    },
  );

  it("keeps implementation constrained to the verified plan", () => {
    const prompt = buildTaskSessionImplementationPrompt({
      projectId,
      card,
      approvedPlan,
    });

    expect(prompt).toContain('"id": "REQ-1"');
    expect(prompt).toContain(
      "Implement only the approved requirements and steps",
    );
    expect(prompt).toContain("do not silently broaden scope");
  });

  it("rejects plan/task identity mismatches before prompt construction", () => {
    expect(() =>
      buildTaskSessionImplementationPrompt({
        projectId,
        card,
        approvedPlan: { ...approvedPlan, cardId: "another-card" },
      }),
    ).toThrow("does not match the implementation task identity");
  });
});
