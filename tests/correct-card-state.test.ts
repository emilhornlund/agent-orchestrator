import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { correctCardToBacklog } from "../src/orchestrator/correct-card-state.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

const project = {
  id: "project-1",
  trello: { backlogListId: "backlog-list" },
} as ProjectConfig;

const card: TrelloCard = {
  id: "card-1",
  name: "Task",
  desc: "",
  idList: "working-list",
  idLabels: [],
  url: "https://trello.com/c/card-1",
};

describe("correctCardToBacklog", () => {
  it("moves a card to Backlog and explains the correction", async () => {
    const moveCard = vi
      .fn()
      .mockResolvedValue({ ...card, idList: "backlog-list" });
    const addComment = vi.fn().mockResolvedValue(undefined);
    const trello = { moveCard, addComment } as unknown as TrelloClient;

    await correctCardToBacklog(trello, project, card, "invalid transition");

    expect(moveCard).toHaveBeenCalledWith("card-1", "backlog-list");
    expect(addComment).toHaveBeenCalledWith(
      "card-1",
      expect.stringContaining("Reason: invalid transition"),
    );
  });

  it("does not add an explanation when the Backlog move fails", async () => {
    const addComment = vi.fn();
    const trello = {
      moveCard: vi.fn().mockRejectedValue(new Error("Trello unavailable")),
      addComment,
    } as unknown as TrelloClient;

    await expect(
      correctCardToBacklog(trello, project, card, "invalid transition"),
    ).rejects.toThrow("Could not move card to Backlog");

    expect(addComment).not.toHaveBeenCalled();
  });
});
