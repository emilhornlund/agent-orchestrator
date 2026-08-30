import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { validateProjectTrello } from "../src/trello/validate-project-trello.js";
import type { TrelloClient } from "../src/trello/trello-client.js";

const project = {
  id: "example",
  trello: {
    boardId: "board-1",
    backlogListId: "backlog",
    readyListId: "ready",
    workingListId: "working",
    reviewListId: "review",
    failedListId: "failed",
    doneListId: "done",
    refinementLabelId: "refinement-label",
    featureLabelId: "feature-label",
    improvementLabelId: "improvement-label",
    bugLabelId: "bug-label",
  },
} as ProjectConfig;

const lists = [
  { id: "backlog", name: "Backlog", closed: false },
  { id: "ready", name: "Ready", closed: false },
  { id: "working", name: "Working", closed: false },
  { id: "review", name: "Review", closed: false },
  { id: "failed", name: "Failed", closed: false },
  { id: "done", name: "Done", closed: false },
];

const labels = [
  { id: "refinement-label", name: "Refinement", color: "purple" },
  { id: "feature-label", name: "Feature", color: "green" },
  { id: "improvement-label", name: "Improvement", color: "blue" },
  { id: "bug-label", name: "Bug", color: "red" },
];

describe("validateProjectTrello", () => {
  it("accepts all required lists and labels on the configured board", async () => {
    const trello = {
      getBoard: vi.fn().mockResolvedValue({
        id: "board-1",
        name: "Workflow",
        url: "https://trello.com/b/board-1/workflow",
      }),
      getLists: vi.fn().mockResolvedValue(lists),
      getLabels: vi.fn().mockResolvedValue(labels),
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
      getLabels: vi.fn().mockResolvedValue(labels),
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
      getLists: vi
        .fn()
        .mockResolvedValue(lists.filter((list) => list.id !== "done")),
      getLabels: vi.fn().mockResolvedValue(labels),
    } as unknown as TrelloClient;

    await expect(validateProjectTrello(trello, project)).rejects.toThrow(
      "doneListId",
    );
  });

  it("rejects a missing configured backlog list", async () => {
    const trello = {
      getBoard: vi.fn().mockResolvedValue({
        id: "board-1",
        name: "Workflow",
        url: "https://trello.com/b/board-1/workflow",
      }),
      getLists: vi
        .fn()
        .mockResolvedValue(lists.filter((list) => list.id !== "backlog")),
      getLabels: vi.fn().mockResolvedValue(labels),
    } as unknown as TrelloClient;

    await expect(validateProjectTrello(trello, project)).rejects.toThrow(
      "backlogListId",
    );
  });

  it("rejects a configured label that is missing", async () => {
    const trello = {
      getBoard: vi.fn().mockResolvedValue({
        id: "board-1",
        name: "Workflow",
        url: "https://trello.com/b/board-1/workflow",
      }),
      getLists: vi.fn().mockResolvedValue(lists),
      getLabels: vi
        .fn()
        .mockResolvedValue(
          labels.filter((label) => label.id !== "improvement-label"),
        ),
    } as unknown as TrelloClient;

    await expect(validateProjectTrello(trello, project)).rejects.toThrow(
      "improvementLabelId",
    );
  });
});
