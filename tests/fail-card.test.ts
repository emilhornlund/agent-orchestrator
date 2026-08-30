import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { OpenCodeTimeoutError } from "../src/opencode/opencode-client.js";
import { failCard } from "../src/orchestrator/fail-card.js";
import { WorkflowError } from "../src/orchestrator/workflow-error.js";
import { TrelloClient } from "../src/trello/trello-client.js";

const project = {
  id: "project",
  trello: { failedListId: "failed" },
} as ProjectConfig;

function card(id = "card-1") {
  return {
    id,
    name: "Task",
    desc: "",
    idList: "working",
    idLabels: [],
    url: `https://trello.example/${id}`,
  };
}

describe("failCard", () => {
  it("moves the card to Failed, comments, and rethrows the workflow error", async () => {
    const trello = new TrelloClient({ apiKey: "key", token: "token" });
    const moveCard = vi
      .spyOn(trello, "moveCard")
      .mockResolvedValue({ ...card(), idList: "failed" });
    const addComment = vi.spyOn(trello, "addComment").mockResolvedValue({
      id: "action-1",
      type: "commentCard",
      date: "2026-08-30T09:00:00.000Z",
    });
    const error = new Error("implementation failed");

    await expect(failCard(trello, project, "card-1", error)).rejects.toBe(
      error,
    );

    expect(moveCard).toHaveBeenCalledWith("card-1", "failed");
    expect(addComment).toHaveBeenCalledWith(
      "card-1",
      expect.stringContaining("Reason: implementation failed"),
    );
  });

  it("preserves both errors when moving to Failed fails", async () => {
    const trello = new TrelloClient({ apiKey: "key", token: "token" });
    const moveError = new Error("Trello unavailable");
    vi.spyOn(trello, "moveCard").mockRejectedValue(moveError);
    const error = new Error("implementation failed");

    await expect(
      failCard(trello, project, "card-1", error),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        "additionally failed to move card to Failed",
      ),
      cause: moveError,
    });
  });

  it("keeps the primary failure when adding the comment fails", async () => {
    const trello = new TrelloClient({ apiKey: "key", token: "token" });
    vi.spyOn(trello, "moveCard").mockResolvedValue({
      ...card(),
      idList: "failed",
    });
    vi.spyOn(trello, "addComment").mockRejectedValue(
      new Error("comment failed"),
    );
    const error = new Error("implementation failed");

    await expect(failCard(trello, project, "card-1", error)).rejects.toBe(
      error,
    );
  });

  it("uses explicit failure categories and timeout descriptions", async () => {
    const trello = new TrelloClient({ apiKey: "key", token: "token" });
    vi.spyOn(trello, "moveCard").mockResolvedValue({
      ...card(),
      idList: "failed",
    });
    const addComment = vi.spyOn(trello, "addComment").mockResolvedValue({
      id: "action-1",
      type: "commentCard",
      date: "2026-08-30T09:00:00.000Z",
    });

    await expect(
      failCard(
        trello,
        project,
        "card-1",
        new WorkflowError("OpenCode", "agent failed"),
      ),
    ).rejects.toThrow("agent failed");
    expect(addComment).toHaveBeenCalledWith(
      "card-1",
      expect.stringContaining("Category: OpenCode"),
    );

    const timeout = new OpenCodeTimeoutError(1000);
    await expect(failCard(trello, project, "card-1", timeout)).rejects.toBe(
      timeout,
    );
    expect(fs.existsSync(path.join(process.cwd(), "logs"))).toBe(true);
  });
});
