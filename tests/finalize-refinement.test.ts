import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { finalizeRefinement } from "../src/refinement/finalize-refinement.js";
import type { RefinementResult } from "../src/refinement/refinement-result.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

function createProject(): ProjectConfig {
  return {
    id: "project",
    autoMerge: false,
    trello: {
      boardId: "board",
      backlogListId: "backlog",
      readyListId: "ready",
      workingListId: "working",
      reviewListId: "review",
      failedListId: "failed",
      doneListId: "done",
      refinementLabelId: "refinement",
      featureLabelId: "feature",
      improvementLabelId: "improvement",
      bugLabelId: "bug",
    },
    repository: {
      path: "/tmp/repository",
      github: "owner/repository",
      defaultBranch: "main",
      worktreeRoot: "/tmp/worktrees",
      gitIdentity: {
        name: "Agent Orchestrator",
        email: "agent-orchestrator@users.noreply.github.com",
      },
    },
    opencode: {
      refinement: {
        model: "openai/refinement-model",
        variant: "xhigh",
      },
      implementation: {
        model: "openai/implementation-model",
        variant: "xhigh",
      },
      review: {
        model: "openai/review-model",
        variant: "high",
      },
      remediation: {
        model: "openai/remediation-model",
        variant: "xhigh",
      },
      commit: {
        model: "openai/commit-model",
        variant: "low",
      },
      timeoutMinutes: 360,
    },
  };
}

function createResult(type: RefinementResult["type"]): RefinementResult {
  return {
    title: "Add inventory support",
    type,
    description:
      "# Add inventory support\n\n## Description\n\nAdd inventory support.",
  };
}

function createCard(idLabels: string[] = ["refinement"]): TrelloCard {
  return {
    id: "card-123",
    name: "Original task",
    desc: "Original description",
    idList: "working",
    idLabels,
    url: "https://trello.example/card-123",
  };
}

function createTrelloMock() {
  return {
    updateCardContent: vi.fn(async () => undefined),
    addLabel: vi.fn(async () => undefined),
    removeLabel: vi.fn(async () => undefined),
    moveCard: vi.fn(async () => undefined),
  };
}

describe("finalizeRefinement", () => {
  it.each([
    ["feature", "feature"],
    ["improvement", "improvement"],
    ["bug", "bug"],
  ] as const)(
    "adds the configured %s classification when it is missing",
    async (type, expectedLabelId) => {
      const trello = createTrelloMock();

      await finalizeRefinement(
        trello as unknown as TrelloClient,
        createProject(),
        createCard(["refinement"]),
        createResult(type),
      );

      expect(trello.addLabel).toHaveBeenCalledWith("card-123", expectedLabelId);
    },
  );

  it("removes an existing conflicting classification before applying the selected one", async () => {
    const trello = createTrelloMock();

    await finalizeRefinement(
      trello as unknown as TrelloClient,
      createProject(),
      createCard(["refinement", "feature", "improvement"]),
      createResult("bug"),
    );

    expect(trello.removeLabel).toHaveBeenCalledWith("card-123", "feature");

    expect(trello.removeLabel).toHaveBeenCalledWith("card-123", "improvement");

    expect(trello.addLabel).toHaveBeenCalledWith("card-123", "bug");
  });

  it("does not re-add the selected classification when it is already present", async () => {
    const trello = createTrelloMock();

    await finalizeRefinement(
      trello as unknown as TrelloClient,
      createProject(),
      createCard(["refinement", "feature"]),
      createResult("feature"),
    );

    expect(trello.addLabel).not.toHaveBeenCalled();

    expect(trello.removeLabel).toHaveBeenCalledWith("card-123", "refinement");

    expect(trello.removeLabel).not.toHaveBeenCalledWith("card-123", "feature");
  });

  it("updates the card content before changing labels or list", async () => {
    const trello = createTrelloMock();

    await finalizeRefinement(
      trello as unknown as TrelloClient,
      createProject(),
      createCard(),
      createResult("feature"),
    );

    expect(trello.updateCardContent).toHaveBeenCalledWith(
      "card-123",
      "Add inventory support",
      "# Add inventory support\n\n## Description\n\nAdd inventory support.",
    );

    expect(trello.updateCardContent.mock.invocationCallOrder[0]).toBeLessThan(
      trello.addLabel.mock.invocationCallOrder[0]!,
    );
  });

  it("applies Trello mutations in the required order", async () => {
    const trello = createTrelloMock();

    await finalizeRefinement(
      trello as unknown as TrelloClient,
      createProject(),
      createCard(),
      createResult("improvement"),
    );

    const updateOrder = trello.updateCardContent.mock.invocationCallOrder[0]!;
    const addLabelOrder = trello.addLabel.mock.invocationCallOrder[0]!;
    const removeLabelOrder = trello.removeLabel.mock.invocationCallOrder[0]!;
    const moveOrder = trello.moveCard.mock.invocationCallOrder[0]!;

    expect(updateOrder).toBeLessThan(addLabelOrder);
    expect(addLabelOrder).toBeLessThan(removeLabelOrder);
    expect(removeLabelOrder).toBeLessThan(moveOrder);
  });

  it("removes the refinement label", async () => {
    const trello = createTrelloMock();

    await finalizeRefinement(
      trello as unknown as TrelloClient,
      createProject(),
      createCard(),
      createResult("bug"),
    );

    expect(trello.removeLabel).toHaveBeenCalledWith("card-123", "refinement");
  });

  it("moves the refined card to the backlog", async () => {
    const trello = createTrelloMock();

    await finalizeRefinement(
      trello as unknown as TrelloClient,
      createProject(),
      createCard(),
      createResult("feature"),
    );

    expect(trello.moveCard).toHaveBeenCalledWith("card-123", "backlog");
  });

  it("stops immediately when updating card content fails", async () => {
    const trello = createTrelloMock();

    trello.updateCardContent.mockRejectedValueOnce(new Error("update failed"));

    await expect(
      finalizeRefinement(
        trello as unknown as TrelloClient,
        createProject(),
        createCard(),
        createResult("feature"),
      ),
    ).rejects.toThrow("update failed");

    expect(trello.addLabel).not.toHaveBeenCalled();
    expect(trello.removeLabel).not.toHaveBeenCalled();
    expect(trello.moveCard).not.toHaveBeenCalled();
  });
});
