import { describe, expect, it, vi } from "vitest";

import type { Config } from "../src/config/config.js";
import { claimNextRefinementCard } from "../src/orchestrator/claim-next-refinement-card.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

type Project = Config["projects"][number];

function createProject(): Project {
  return {
    id: "rpg-sdl",

    trello: {
      boardId: "board-1",
      backlogListId: "backlog-list",
      readyListId: "ready-list",
      workingListId: "working-list",
      reviewListId: "review-list",
      failedListId: "failed-list",
      doneListId: "done-list",
      refinementLabelId: "refinement-label",
      featureLabelId: "feature-label",
      improvementLabelId: "improvement-label",
      bugLabelId: "bug-label",
    },

    repository: {
      path: "/projects/rpg-sdl",
      github: "emilhornlund/rpg-sdl",
      defaultBranch: "main",
      worktreeRoot: "/projects/.agent-worktrees/rpg-sdl",
      gitIdentity: {
        name: "Agent Orchestrator",
        email: "agent-orchestrator@users.noreply.github.com",
      },
    },

    opencode: {
      refinement: {
        model: "refinement-model",
        variant: "refinement-variant",
      },
      implementation: {
        model: "implementation-model",
        variant: "implementation-variant",
      },
      review: {
        model: "review-model",
        variant: "review-variant",
      },
      remediation: {
        model: "remediation-model",
        variant: "remediation-variant",
      },
      commit: {
        model: "commit-model",
        variant: "commit-variant",
      },
      timeoutMinutes: 360,
    },
  };
}

function createCard(overrides: Partial<TrelloCard> = {}): TrelloCard {
  return {
    id: "card-1",
    name: "Refine inventory task",
    desc: "Inventory needs work.",
    idList: "ready-list",
    idLabels: ["refinement-label"],
    url: "https://trello.com/c/example",
    ...overrides,
  };
}

describe("claimNextRefinementCard", () => {
  it("returns null when no cards are ready", async () => {
    const trello = {
      getCards: vi.fn().mockResolvedValue([]),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;

    const card = await claimNextRefinementCard(trello, createProject());

    expect(card).toBeNull();
    expect(trello.getCards).toHaveBeenCalledWith("ready-list");
    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("claims the first card with the refinement label", async () => {
    const firstCard = createCard({
      id: "card-1",
      name: "First refinement",
    });

    const secondCard = createCard({
      id: "card-2",
      name: "Second refinement",
    });

    const claimedCard = createCard({
      id: "card-1",
      name: "First refinement",
      idList: "working-list",
    });

    const trello = {
      getCards: vi.fn().mockResolvedValue([firstCard, secondCard]),
      moveCard: vi.fn().mockResolvedValue(claimedCard),
    } as unknown as TrelloClient;

    const card = await claimNextRefinementCard(trello, createProject());

    expect(trello.moveCard).toHaveBeenCalledOnce();
    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "working-list");
    expect(card).toEqual(claimedCard);
  });

  it.each([
    [[]],
    [["feature-label"]],
    [["improvement-label"]],
    [["bug-label"]],
  ])(
    "claims a refinement card with additional labels %j",
    async (additionalLabels) => {
      const readyCard = createCard({
        idLabels: ["refinement-label", ...additionalLabels],
      });

      const claimedCard = createCard({
        idList: "working-list",
        idLabels: ["refinement-label", ...additionalLabels],
      });

      const trello = {
        getCards: vi.fn().mockResolvedValue([readyCard]),
        moveCard: vi.fn().mockResolvedValue(claimedCard),
      } as unknown as TrelloClient;

      const card = await claimNextRefinementCard(trello, createProject());

      expect(trello.moveCard).toHaveBeenCalledWith("card-1", "working-list");
      expect(card).toEqual(claimedCard);
    },
  );

  it("skips implementation-only cards", async () => {
    const featureCard = createCard({
      id: "card-1",
      name: "Implement inventory",
      idLabels: ["feature-label"],
    });

    const refinementCard = createCard({
      id: "card-2",
      name: "Refine inventory task",
      idLabels: ["refinement-label"],
    });

    const claimedCard = createCard({
      id: "card-2",
      name: "Refine inventory task",
      idList: "working-list",
      idLabels: ["refinement-label"],
    });

    const trello = {
      getCards: vi.fn().mockResolvedValue([featureCard, refinementCard]),
      moveCard: vi.fn().mockResolvedValue(claimedCard),
    } as unknown as TrelloClient;

    const card = await claimNextRefinementCard(trello, createProject());

    expect(trello.moveCard).toHaveBeenCalledOnce();
    expect(trello.moveCard).toHaveBeenCalledWith("card-2", "working-list");
    expect(card).toEqual(claimedCard);
  });

  it("returns null when no refinement cards are ready", async () => {
    const cards = [
      createCard({
        id: "card-1",
        idLabels: [],
      }),
      createCard({
        id: "card-2",
        idLabels: ["feature-label"],
      }),
      createCard({
        id: "card-3",
        idLabels: ["bug-label"],
      }),
    ];

    const trello = {
      getCards: vi.fn().mockResolvedValue(cards),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;

    const card = await claimNextRefinementCard(trello, createProject());

    expect(card).toBeNull();
    expect(trello.moveCard).not.toHaveBeenCalled();
  });
});
