import { describe, expect, it } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import {
  createWorkflowOwnership,
  serializeWorkflowOwnership,
  validateWorkflowOwnership,
} from "../src/trello/workflow-ownership.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

const project = { id: "project-1" } as ProjectConfig;

function createCard(overrides: Partial<TrelloCard> = {}): TrelloCard {
  return {
    id: "card-1",
    name: "Task",
    desc: "",
    idList: "working",
    idLabels: [],
    url: "https://trello.com/c/card-1",
    ...overrides,
  };
}

function marker(cardId = "card-1", workflow = "implementation"): string {
  return JSON.stringify({
    version: 1,
    owner: "agent-orchestrator",
    projectId: "project-1",
    cardId,
    workflow,
  });
}

describe("workflow ownership", () => {
  it("creates the documented ownership marker shape", () => {
    const ownership = createWorkflowOwnership(
      project,
      createCard(),
      "implementation",
    );

    expect(serializeWorkflowOwnership(ownership)).toBe(marker());
  });

  it("distinguishes a missing marker", () => {
    expect(validateWorkflowOwnership(createCard(), project)).toEqual({
      status: "missing",
      reason: "no ownership marker was found",
    });
  });

  it("accepts a matching marker for the expected workflow", () => {
    expect(
      validateWorkflowOwnership(
        createCard({ workflowOwnership: marker() }),
        project,
        "implementation",
      ),
    ).toEqual({
      status: "owned",
      ownership: {
        version: 1,
        owner: "agent-orchestrator",
        projectId: "project-1",
        cardId: "card-1",
        workflow: "implementation",
      },
    });
  });

  it.each([
    ["not-json", "the ownership marker is not valid JSON"],
    ["{}", "the ownership marker has an invalid shape or version"],
    [marker("other-card"), 'belongs to card "other-card"'],
    [
      JSON.stringify({
        version: 1,
        owner: "agent-orchestrator",
        projectId: "other-project",
        cardId: "card-1",
        workflow: "implementation",
      }),
      'belongs to project "other-project"',
    ],
  ])("rejects invalid marker %j", (raw, reason) => {
    const result = validateWorkflowOwnership(
      createCard({ workflowOwnership: raw }),
      project,
    );

    expect(result.status).toBe("invalid");
    expect(result).toMatchObject({
      reason: expect.stringContaining(reason),
    });
  });

  it("rejects a marker for a different workflow", () => {
    const result = validateWorkflowOwnership(
      createCard({ workflowOwnership: marker("card-1", "refinement") }),
      project,
      "implementation",
    );

    expect(result).toMatchObject({
      status: "invalid",
      reason:
        "the ownership marker identifies a refinement workflow, not implementation",
    });
  });

  it("rejects conflicting custom-field values", () => {
    const result = validateWorkflowOwnership(
      createCard({
        workflowOwnership: marker(),
        workflowOwnershipValues: [marker(), marker("other-card")],
      }),
      project,
    );

    expect(result).toEqual({
      status: "invalid",
      reason: "multiple ownership marker values were returned",
    });
  });
});
