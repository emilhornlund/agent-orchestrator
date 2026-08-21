import { describe, expect, it, vi } from "vitest";

import type { Config } from "../src/config/config.js";
import { claimNextCard } from "../src/orchestrator/claim-next-card.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

type Project = Config["projects"][number];

function createProject(): Project {
  return {
    id: "rpg-sdl",

    trello: {
      boardId: "board-1",
      readyListId: "ready-list",
      workingListId: "working-list",
      reviewListId: "review-list",
      failedListId: "failed-list",
      doneListId: "done-list",
    },

    repository: {
      path: "/projects/rpg-sdl",
      github: "emilhornlund/rpg-sdl",
      defaultBranch: "main",
      worktreeRoot: "/projects/.agent-worktrees/rpg-sdl",
    },

    opencode: {
      model: "gpt-5.6-luna",
      variant: "xhigh",
    },
  };
}

function createCard(overrides: Partial<TrelloCard> = {}): TrelloCard {
  return {
    id: "card-1",
    name: "Implement inventory",
    desc: "Add inventory support",
    idList: "ready-list",
    url: "https://trello.com/c/example",
    ...overrides,
  };
}

describe("claimNextCard", () => {
  it("returns null when no cards are ready", async () => {
    const trello = {
      getCards: vi.fn().mockResolvedValue([]),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;

    const project = createProject();

    const card = await claimNextCard(trello, project);

    expect(card).toBeNull();
    expect(trello.getCards).toHaveBeenCalledWith("ready-list");
    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("moves the first ready card to the working list", async () => {
    const readyCard = createCard();

    const claimedCard = createCard({
      idList: "working-list",
    });

    const trello = {
      getCards: vi.fn().mockResolvedValue([readyCard]),
      moveCard: vi.fn().mockResolvedValue(claimedCard),
    } as unknown as TrelloClient;

    const project = createProject();

    const card = await claimNextCard(trello, project);

    expect(trello.getCards).toHaveBeenCalledWith("ready-list");
    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "working-list");
    expect(card).toEqual(claimedCard);
  });

  it("claims only the first ready card", async () => {
    const firstCard = createCard({
      id: "card-1",
      name: "First card",
    });

    const secondCard = createCard({
      id: "card-2",
      name: "Second card",
    });

    const claimedCard = createCard({
      id: "card-1",
      name: "First card",
      idList: "working-list",
    });

    const trello = {
      getCards: vi.fn().mockResolvedValue([firstCard, secondCard]),
      moveCard: vi.fn().mockResolvedValue(claimedCard),
    } as unknown as TrelloClient;

    const project = createProject();

    await claimNextCard(trello, project);

    expect(trello.moveCard).toHaveBeenCalledOnce();
    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "working-list");
  });
});
