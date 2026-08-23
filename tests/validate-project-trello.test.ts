import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { validateProjectTrello } from "../src/trello/validate-project-trello.js";
import type { TrelloClient } from "../src/trello/trello-client.js";

const project = {
  id: "example",
  trello: {
    boardId: "board-1",
    readyListId: "ready",
    workingListId: "working",
    reviewListId: "review",
    failedListId: "failed",
    doneListId: "done",
  },
} as ProjectConfig;

const lists = [
  { id: "ready", name: "Ready", closed: false },
  { id: "working", name: "Working", closed: false },
  { id: "review", name: "Review", closed: false },
  { id: "failed", name: "Failed", closed: false },
  { id: "done", name: "Done", closed: false },
];

describe("validateProjectTrello", () => {
  it("accepts all required open lists on the configured board", async () => {
    const trello = {
      getBoard: vi.fn().mockResolvedValue({
        id: "board-1",
        name: "Workflow",
        url: "https://trello.com/b/board-1/workflow",
      }),
      getLists: vi.fn().mockResolvedValue(lists),
    } as unknown as TrelloClient;

    await expect(
      validateProjectTrello(trello, project),
    ).resolves.toBeUndefined();
  });

  it("rejects a configured list that is closed", async () => {
    const trello = {
      getBoard: vi.fn().mockResolvedValue({
        id: "board-1",
        name: "Workflow",
        url: "https://trello.com/b/board-1/workflow",
      }),
      getLists: vi
        .fn()
        .mockResolvedValue(
          lists.map((list) =>
            list.id === "ready" ? { ...list, closed: true } : list,
          ),
        ),
    } as unknown as TrelloClient;

    await expect(validateProjectTrello(trello, project)).rejects.toThrow(
      "readyListId",
    );
  });

  it("rejects a configured list that is missing", async () => {
    const trello = {
      getBoard: vi.fn().mockResolvedValue({
        id: "board-1",
        name: "Workflow",
        url: "https://trello.com/b/board-1/workflow",
      }),
      getLists: vi.fn().mockResolvedValue(lists.slice(0, 4)),
    } as unknown as TrelloClient;

    await expect(validateProjectTrello(trello, project)).rejects.toThrow(
      "doneListId",
    );
  });
});
