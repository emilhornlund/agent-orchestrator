import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { correctCardToBacklog } from "../src/orchestrator/correct-card-state.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

const project = {
  id: "project-1",
  trello: {
    ownershipCustomFieldId: "ownership-field",
    backlogListId: "backlog-list",
  },
} as ProjectConfig;

const card: TrelloCard = {
  id: "card-1",
  name: "Task",
  desc: "",
  idList: "working-list",
  idLabels: [],
  url: "https://trello.com/c/card-1",
};

const marker = JSON.stringify({
  version: 1,
  owner: "agent-orchestrator",
  projectId: "project-1",
  cardId: "card-1",
  workflow: "implementation",
});

describe("correctCardToBacklog", () => {
  it("moves an unowned card to Backlog and explains the correction", async () => {
    const moveCard = vi
      .fn()
      .mockResolvedValue({ ...card, idList: "backlog-list" });
    const addComment = vi.fn().mockResolvedValue(undefined);
    const trello = {
      moveCard,
      addComment,
      clearWorkflowOwnership: vi.fn(),
    } as unknown as TrelloClient;

    await correctCardToBacklog(trello, project, card, "missing ownership");

    expect(moveCard).toHaveBeenCalledWith("card-1", "backlog-list");
    expect(addComment).toHaveBeenCalledWith(
      "card-1",
      expect.stringContaining("Reason: missing ownership"),
    );
    expect(trello.clearWorkflowOwnership).not.toHaveBeenCalled();
  });

  it("moves a card before clearing its invalid marker", async () => {
    const events: string[] = [];
    const clearWorkflowOwnership = vi.fn(async () => {
      events.push("clear");
    });
    const moveCard = vi.fn(async () => {
      events.push("move");
      return { ...card, idList: "backlog-list" };
    });
    const trello = {
      clearWorkflowOwnership,
      moveCard,
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;

    await correctCardToBacklog(
      trello,
      project,
      { ...card, workflowOwnership: marker },
      "unexpected state",
    );

    expect(events).toEqual(["move", "clear"]);
    expect(clearWorkflowOwnership).toHaveBeenCalledWith(
      "card-1",
      "ownership-field",
    );
  });

  it("surfaces marker clearing failures after moving the card", async () => {
    const moveCard = vi.fn().mockResolvedValue({
      ...card,
      idList: "backlog-list",
    });
    const trello = {
      clearWorkflowOwnership: vi
        .fn()
        .mockRejectedValue(new Error("Trello unavailable")),
      moveCard,
      addComment: vi.fn(),
    } as unknown as TrelloClient;

    await expect(
      correctCardToBacklog(
        trello,
        project,
        { ...card, workflowOwnership: marker },
        "unexpected state",
      ),
    ).rejects.toThrow("Could not clear the ownership marker");

    expect(moveCard).toHaveBeenCalledWith("card-1", "backlog-list");
  });

  it("keeps an invalid marker when moving the card to Backlog fails", async () => {
    const moveCard = vi.fn().mockRejectedValue(new Error("Trello unavailable"));
    const clearWorkflowOwnership = vi.fn().mockResolvedValue(undefined);
    const trello = {
      clearWorkflowOwnership,
      moveCard,
      addComment: vi.fn(),
    } as unknown as TrelloClient;

    await expect(
      correctCardToBacklog(
        trello,
        project,
        { ...card, workflowOwnership: marker },
        "unexpected state",
      ),
    ).rejects.toThrow("Could not move card to Backlog");

    expect(clearWorkflowOwnership).not.toHaveBeenCalled();
  });

  it("does not add an explanation when the Backlog move fails", async () => {
    const addComment = vi.fn();
    const trello = {
      moveCard: vi.fn().mockRejectedValue(new Error("Trello unavailable")),
      addComment,
      clearWorkflowOwnership: vi.fn(),
    } as unknown as TrelloClient;

    await expect(
      correctCardToBacklog(trello, project, card, "unexpected state"),
    ).rejects.toThrow("Could not move card to Backlog");

    expect(addComment).not.toHaveBeenCalled();
  });
});
