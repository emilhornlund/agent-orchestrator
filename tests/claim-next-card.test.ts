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
      ownershipCustomFieldId: "ownership-field",
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
        model: "openai/refinement-model",
        variant: "xhigh",
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
    name: "Implement inventory",
    desc: "Add inventory support",
    idList: "ready-list",
    idLabels: ["feature-label"],
    url: "https://trello.com/c/example",
    ...overrides,
  };
}

describe("claimNextCard", () => {
  it("returns null when no cards are ready", async () => {
    const trello = {
      getCards: vi.fn().mockResolvedValue([]),
      setWorkflowOwnership: vi.fn(),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;

    const project = createProject();

    const card = await claimNextCard(trello, project);

    expect(card).toBeNull();
    expect(trello.getCards).toHaveBeenCalledWith("ready-list", {
      workflowOwnershipCustomFieldId: "ownership-field",
    });
    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("moves the first implementation card to the working list", async () => {
    const readyCard = createCard();

    const claimedCard = createCard({
      idList: "working-list",
      workflowOwnership: expect.any(String) as unknown as string,
    });

    const trello = {
      getCards: vi.fn().mockResolvedValue([readyCard]),
      setWorkflowOwnership: vi.fn(),
      moveCard: vi.fn().mockResolvedValue(claimedCard),
    } as unknown as TrelloClient;

    const project = createProject();

    const card = await claimNextCard(trello, project);

    expect(trello.getCards).toHaveBeenCalledWith("ready-list", {
      workflowOwnershipCustomFieldId: "ownership-field",
    });
    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "working-list");
    expect(card).toEqual(claimedCard);
  });

  it("claims the first implementation card", async () => {
    const firstCard = createCard({
      id: "card-1",
      name: "First card",
      idLabels: ["improvement-label"],
    });

    const secondCard = createCard({
      id: "card-2",
      name: "Second card",
      idLabels: ["bug-label"],
    });

    const claimedCard = createCard({
      id: "card-1",
      name: "First card",
      idList: "working-list",
      idLabels: ["improvement-label"],
      workflowOwnership: expect.any(String) as unknown as string,
    });

    const trello = {
      getCards: vi.fn().mockResolvedValue([firstCard, secondCard]),
      setWorkflowOwnership: vi.fn(),
      moveCard: vi.fn().mockResolvedValue(claimedCard),
    } as unknown as TrelloClient;

    const project = createProject();

    await claimNextCard(trello, project);

    expect(trello.moveCard).toHaveBeenCalledOnce();
    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "working-list");
  });

  it("skips refinement cards when claiming implementation work", async () => {
    const refinementCard = createCard({
      id: "card-1",
      name: "Refine inventory task",
      idLabels: ["refinement-label"],
    });

    const featureCard = createCard({
      id: "card-2",
      name: "Implement inventory",
      idLabels: ["feature-label"],
    });

    const claimedCard = createCard({
      id: "card-2",
      name: "Implement inventory",
      idList: "working-list",
      idLabels: ["feature-label"],
      workflowOwnership: expect.any(String) as unknown as string,
    });

    const trello = {
      getCards: vi.fn().mockResolvedValue([refinementCard, featureCard]),
      setWorkflowOwnership: vi.fn(),
      moveCard: vi.fn().mockResolvedValue(claimedCard),
    } as unknown as TrelloClient;

    const project = createProject();

    const card = await claimNextCard(trello, project);

    expect(trello.moveCard).toHaveBeenCalledOnce();
    expect(trello.moveCard).toHaveBeenCalledWith("card-2", "working-list");
    expect(card).toEqual(claimedCard);
  });

  it("skips cards that have both refinement and implementation labels", async () => {
    const refinementFeatureCard = createCard({
      id: "card-1",
      name: "Refine inventory task",
      idLabels: ["refinement-label", "feature-label"],
    });

    const improvementCard = createCard({
      id: "card-2",
      name: "Improve inventory",
      idLabels: ["improvement-label"],
    });

    const claimedCard = createCard({
      id: "card-2",
      name: "Improve inventory",
      idList: "working-list",
      idLabels: ["improvement-label"],
      workflowOwnership: expect.any(String) as unknown as string,
    });

    const trello = {
      getCards: vi
        .fn()
        .mockResolvedValue([refinementFeatureCard, improvementCard]),
      setWorkflowOwnership: vi.fn(),
      moveCard: vi.fn().mockResolvedValue(claimedCard),
    } as unknown as TrelloClient;

    const project = createProject();

    const card = await claimNextCard(trello, project);

    expect(trello.moveCard).toHaveBeenCalledOnce();
    expect(trello.moveCard).toHaveBeenCalledWith("card-2", "working-list");
    expect(card).toEqual(claimedCard);
  });

  it("returns null when only a refinement card with an implementation label is ready", async () => {
    const card = createCard({
      idLabels: ["refinement-label", "bug-label"],
    });

    const trello = {
      getCards: vi.fn().mockResolvedValue([card]),
      setWorkflowOwnership: vi.fn(),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;

    const project = createProject();

    const claimedCard = await claimNextCard(trello, project);

    expect(claimedCard).toBeNull();
    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("skips unlabeled cards when claiming implementation work", async () => {
    const unlabeledCard = createCard({
      id: "card-1",
      name: "Unclassified task",
      idLabels: [],
    });

    const bugCard = createCard({
      id: "card-2",
      name: "Fix inventory crash",
      idLabels: ["bug-label"],
    });

    const claimedCard = createCard({
      id: "card-2",
      name: "Fix inventory crash",
      idList: "working-list",
      idLabels: ["bug-label"],
      workflowOwnership: expect.any(String) as unknown as string,
    });

    const trello = {
      getCards: vi.fn().mockResolvedValue([unlabeledCard, bugCard]),
      setWorkflowOwnership: vi.fn(),
      moveCard: vi.fn().mockResolvedValue(claimedCard),
    } as unknown as TrelloClient;

    const project = createProject();

    const card = await claimNextCard(trello, project);

    expect(trello.moveCard).toHaveBeenCalledOnce();
    expect(trello.moveCard).toHaveBeenCalledWith("card-2", "working-list");
    expect(card).toEqual(claimedCard);
  });

  it("returns null when no implementation cards are ready", async () => {
    const cards = [
      createCard({
        id: "card-1",
        idLabels: [],
      }),
      createCard({
        id: "card-2",
        idLabels: ["refinement-label"],
      }),
    ];

    const trello = {
      getCards: vi.fn().mockResolvedValue(cards),
      setWorkflowOwnership: vi.fn(),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;

    const project = createProject();

    const card = await claimNextCard(trello, project);

    expect(card).toBeNull();
    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("skips invalidly owned cards and claims the next eligible card", async () => {
    const invalidCard = createCard({
      id: "card-1",
      workflowOwnership: "not-json",
    });
    const eligibleCard = createCard({ id: "card-2" });
    const setWorkflowOwnership = vi.fn().mockResolvedValue(undefined);
    const moveCard = vi
      .fn()
      .mockResolvedValue(createCard({ id: "card-2", idList: "working-list" }));

    const trello = {
      getCards: vi.fn().mockResolvedValue([invalidCard, eligibleCard]),
      setWorkflowOwnership,
      moveCard,
    } as unknown as TrelloClient;

    const card = await claimNextCard(trello, createProject());

    expect(setWorkflowOwnership).toHaveBeenCalledWith(
      "card-2",
      "ownership-field",
      expect.objectContaining({
        projectId: "rpg-sdl",
        cardId: "card-2",
        workflow: "implementation",
      }),
    );
    expect(moveCard).toHaveBeenCalledWith("card-2", "working-list");
    expect(card?.id).toBe("card-2");
  });

  it("writes ownership before moving a card to Working", async () => {
    const events: string[] = [];
    const readyCard = createCard();
    const setWorkflowOwnership = vi.fn(async () => {
      events.push("set-ownership");
    });
    const moveCard = vi.fn(async () => {
      events.push("move-card");
      return createCard({ idList: "working-list" });
    });

    const trello = {
      getCards: vi.fn().mockResolvedValue([readyCard]),
      setWorkflowOwnership,
      moveCard,
    } as unknown as TrelloClient;

    await claimNextCard(trello, createProject());

    expect(events).toEqual(["set-ownership", "move-card"]);
  });

  it.each(["featureLabelId", "improvementLabelId", "bugLabelId"] as const)(
    "accepts cards with the configured %s",
    async (labelKey) => {
      const project = createProject();
      const labelId = project.trello[labelKey];

      const readyCard = createCard({
        idLabels: [labelId],
      });

      const claimedCard = createCard({
        idList: "working-list",
        idLabels: [labelId],
        workflowOwnership: expect.any(String) as unknown as string,
      });

      const trello = {
        getCards: vi.fn().mockResolvedValue([readyCard]),
        setWorkflowOwnership: vi.fn(),
        moveCard: vi.fn().mockResolvedValue(claimedCard),
      } as unknown as TrelloClient;

      const card = await claimNextCard(trello, project);

      expect(trello.moveCard).toHaveBeenCalledWith("card-1", "working-list");
      expect(card).toEqual(claimedCard);
    },
  );
});
