import { describe, expect, it } from "vitest";
import { buildTaskSessionReviewRepairPrompt } from "../src/opencode/build-task-session-review-repair-prompt.js";
import type { ImplementationReviewResult } from "../src/task-session/implementation-review-result.js";
import type { TaskPlan } from "../src/task-session/task-plan.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

const card: TrelloCard = {
  id: "card-1",
  name: "Fix task behavior",
  desc: "Implement the approved behavior.",
  idList: "ready",
  idLabels: [],
  url: "https://trello.com/c/card-1",
};

const approvedPlan: TaskPlan = {
  version: 1,
  projectId: "project-1",
  cardId: card.id,
  requirements: [
    {
      id: "REQ-1",
      text: "Preserve the task behavior.",
      verification: "Confirm the behavior remains supported.",
    },
  ],
  steps: [
    {
      id: "STEP-1",
      description: "Implement the behavior.",
      requirementIds: ["REQ-1"],
      verification: "Check the behavior.",
    },
  ],
  assumptions: [],
  blockers: [],
};

const review: ImplementationReviewResult = {
  version: 1,
  projectId: "project-1",
  cardId: card.id,
  verdict: "fail",
  requirementAssessments: [
    {
      requirementId: "REQ-1",
      status: "unsatisfied",
      details: "The behavior is incomplete.",
      evidence: [],
    },
  ],
  blockingFindings: [
    {
      kind: "defect",
      summary: "Incorrect handling",
      detail: "The implementation mishandles empty input.",
      location: { filePath: "src/feature.ts", line: 12 },
    },
    {
      kind: "incomplete",
      summary: "Missing regression coverage",
      detail: "There is no test for empty input.",
      location: { filePath: "tests/feature.test.ts" },
    },
  ],
  reviewedContentIdentity: `sha256:${"a".repeat(64)}`,
};

describe("buildTaskSessionReviewRepairPrompt", () => {
  it("includes the approved context and systematic guidance for every finding", () => {
    const prompt = buildTaskSessionReviewRepairPrompt({
      projectId: "project-1",
      card,
      approvedPlan,
      review,
      attempt: 1,
      maxAttempts: 2,
    });

    expect(prompt).toContain("existing primary task session");
    expect(prompt).toContain(JSON.stringify(approvedPlan, null, 2));
    expect(prompt).toContain(JSON.stringify(review, null, 2));
    expect(prompt).toContain(
      "inspect the relevant implementation and existing tests",
    );
    expect(prompt).toContain("Address every blocking finding");
    expect(prompt).toContain("do not focus only on the first");
    expect(prompt).toContain("underlying defect");
    expect(prompt).toContain("smallest complete correction");
    expect(prompt).toContain("add or update regression tests when appropriate");
    expect(prompt).toContain("original approved requirements remain satisfied");
    expect(prompt).toContain("within the approved task scope");
    expect(prompt).toContain("Do not make superficial changes");
    expect(prompt).toContain("silence a test");
    expect(prompt).toContain("existing repository/worktree context");
    expect(prompt).toContain("Do not start another AI session");
    expect(prompt).toContain("orchestrator-owned validation");
    expect(prompt).toContain("Do not run Git commands or invoke GitHub tools");
  });

  it("rejects plan and review artifacts from another task", () => {
    expect(() =>
      buildTaskSessionReviewRepairPrompt({
        projectId: "project-1",
        card,
        approvedPlan: { ...approvedPlan, cardId: "another-card" },
        review,
        attempt: 1,
        maxAttempts: 2,
      }),
    ).toThrow("Review repair artifacts do not match the task project and card");
  });
});
