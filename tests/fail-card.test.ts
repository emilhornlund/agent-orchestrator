import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import {
  appendSessionLog,
  getSessionLogPath,
  removeSessionLog,
} from "../src/logging/session-log.js";
import { OpenCodeTimeoutError } from "../src/opencode/opencode-client.js";
import type { EmailNotifier } from "../src/notifications/email-notifier.js";
import { failCard } from "../src/orchestrator/fail-card.js";
import { getFailureContext } from "../src/orchestrator/failure-diagnostic.js";
import { WorkflowError } from "../src/orchestrator/workflow-error.js";
import {
  TrelloClient,
  TrelloRequestError,
} from "../src/trello/trello-client.js";

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

function getDailyLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);

  return path.join(process.cwd(), "logs", `test-orchestrator-${date}.log`);
}

afterEach(() => {
  for (const cardId of ["card-1", "card-non-error", "card-session-log"]) {
    removeSessionLog(project.id, cardId);
  }
});

describe("failCard", () => {
  it("sends a Failed email after moving the card and preserves the primary error", async () => {
    const events: string[] = [];
    const notifier: EmailNotifier = {
      send: vi.fn(async (message) => {
        events.push("email");
        expect(message.subject).toContain("Failed");
        expect(message.text).toContain("OpenCode");
        expect(message.text).toContain(
          "To retry deliberately, move this card to Ready for Agent.",
        );
      }),
    };
    const trello = new TrelloClient({ apiKey: "key", token: "token" });
    const moveCard = vi
      .spyOn(trello, "moveCard")
      .mockImplementation(async () => {
        events.push("move");
        return { ...card(), idList: "failed" };
      });
    vi.spyOn(trello, "addComment").mockResolvedValue({
      id: "action-1",
      type: "commentCard",
      date: "2026-08-30T09:00:00.000Z",
    });
    const error = new WorkflowError("OpenCode", "implementation failed");

    await expect(
      failCard(trello, project, "card-1", error, notifier, card()),
    ).rejects.toBe(error);

    expect(moveCard).toHaveBeenCalledWith("card-1", "failed");
    expect(events).toEqual(["move", "email"]);
    expect(notifier.send).toHaveBeenCalledTimes(1);
    expect(getFailureContext(error)?.cardFailureHandled).toBe(true);
  });

  it("keeps Failed state and the primary error when email delivery fails", async () => {
    const notifier: EmailNotifier = {
      send: vi.fn().mockRejectedValue(new Error("SMTP unavailable")),
    };
    const trello = new TrelloClient({ apiKey: "key", token: "token" });
    const moveCard = vi
      .spyOn(trello, "moveCard")
      .mockResolvedValue({ ...card(), idList: "failed" });
    vi.spyOn(trello, "addComment").mockResolvedValue({
      id: "action-1",
      type: "commentCard",
      date: "2026-08-30T09:00:00.000Z",
    });
    const error = new Error("implementation failed");

    await expect(
      failCard(trello, project, "card-1", error, notifier, card()),
    ).rejects.toBe(error);

    expect(moveCard).toHaveBeenCalledWith("card-1", "failed");
    expect(trello.addComment).toHaveBeenCalled();
    expect(getFailureContext(error)?.cardFailureHandled).toBe(true);
  });

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

  it("does not move a card to Failed for a transient Trello failure", async () => {
    const trello = new TrelloClient({ apiKey: "key", token: "token" });
    const moveCard = vi.spyOn(trello, "moveCard");
    const transientError = new TrelloRequestError(
      "card content update",
      "Trello request failed: 503 Unavailable",
      { status: 503, retryable: true },
    );
    const workflowError = new WorkflowError(
      "Workflow",
      "Could not update Trello card content",
      { cause: transientError },
    );

    await expect(
      failCard(trello, project, "card-1", workflowError),
    ).rejects.toBe(workflowError);

    expect(moveCard).not.toHaveBeenCalled();
    expect(getFailureContext(workflowError)).toMatchObject({
      cardFailureHandled: false,
      handlingOutcome:
        "retryable Trello failure; card state left unchanged for reconciliation",
    });
  });

  it("preserves both errors when moving to Failed fails", async () => {
    const trello = new TrelloClient({ apiKey: "key", token: "token" });
    const moveError = new Error("Trello unavailable");
    const moveCard = vi.spyOn(trello, "moveCard").mockRejectedValue(moveError);
    const addComment = vi.spyOn(trello, "addComment");
    const workflowError = new Error("implementation failed");

    try {
      await failCard(trello, project, "card-1", workflowError);
      throw new Error("Expected failCard to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);

      const aggregate = error as AggregateError;

      expect(aggregate.errors).toEqual([workflowError, moveError]);
      expect(aggregate.cause).toBe(moveError);
      expect(aggregate.message).toContain("implementation failed");
      expect(aggregate.message).toContain("Trello unavailable");
    }

    expect(moveCard).toHaveBeenCalledWith("card-1", "failed");
    expect(addComment).not.toHaveBeenCalled();
    expect(fs.readFileSync(getDailyLogPath(), "utf8")).toContain(
      "Failure handling failed: could not move card to Failed: Trello unavailable; preserving the primary failure and skipping the failure comment",
    );
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

    expect(fs.readFileSync(getDailyLogPath(), "utf8")).toContain(
      "Failure handling incomplete: card moved to Failed, but adding the failure comment failed: comment failed; preserving the primary failure",
    );
    expect(getFailureContext(error)?.cardFailureHandled).toBe(true);
  });

  it("logs the category, reason, and retained session log for a failed card", async () => {
    const trello = new TrelloClient({ apiKey: "key", token: "token" });
    vi.spyOn(trello, "moveCard").mockResolvedValue({
      ...card("card-session-log"),
      idList: "failed",
    });
    vi.spyOn(trello, "addComment").mockResolvedValue({
      id: "action-1",
      type: "commentCard",
      date: "2026-08-30T09:00:00.000Z",
    });

    const sessionLogPath = getSessionLogPath(project.id, "card-session-log");
    appendSessionLog(sessionLogPath, "OpenCode output remains here");

    const workflowError = new WorkflowError(
      "Setup",
      "Repository setup exited with code 1",
    );

    await expect(
      failCard(trello, project, "card-session-log", workflowError),
    ).rejects.toBe(workflowError);

    const dailyLog = fs.readFileSync(getDailyLogPath(), "utf8");

    expect(dailyLog).toContain(
      `[project] [card:card-session-log] Task failed. Category: Setup; Reason: Repository setup exited with code 1; Session log: ${sessionLogPath}; attempting to move card to Failed`,
    );
    expect(dailyLog).toContain(
      "Failure handling: card moved to Failed; adding failure comment",
    );
    expect(dailyLog).not.toContain("OpenCode output remains here");
    expect(fs.existsSync(sessionLogPath)).toBe(true);
    expect(fs.readFileSync(sessionLogPath, "utf8")).toBe(
      "OpenCode output remains here",
    );
  });

  it("uses a readable reason for a structured non-Error failure", async () => {
    const trello = new TrelloClient({ apiKey: "key", token: "token" });
    vi.spyOn(trello, "moveCard").mockResolvedValue({
      ...card("card-non-error"),
      idList: "failed",
    });
    const addComment = vi.spyOn(trello, "addComment").mockResolvedValue({
      id: "action-1",
      type: "commentCard",
      date: "2026-08-30T09:00:00.000Z",
    });

    await expect(
      failCard(trello, project, "card-non-error", {
        reason: "the setup tool returned an invalid result",
      }),
    ).rejects.toThrow('{"reason":"the setup tool returned an invalid result"}');

    expect(addComment).toHaveBeenCalledWith(
      "card-non-error",
      expect.stringContaining(
        'Reason: {"reason":"the setup tool returned an invalid result"}',
      ),
    );
  });

  it("labels OpenCode timeout failures explicitly", async () => {
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

    const timeoutError = new OpenCodeTimeoutError(21_600_000);

    await expect(
      failCard(trello, project, "card-1", timeoutError),
    ).rejects.toBe(timeoutError);

    expect(addComment).toHaveBeenCalledWith(
      "card-1",
      [
        "Agent Orchestrator failed.",
        "",
        "Category: OpenCode timeout",
        "Reason: OpenCode exceeded safety timeout of 21600000ms",
        "",
        "To retry deliberately, move this card to Ready for Agent.",
      ].join("\n"),
    );
  });

  it("does not infer a category from an ordinary error message", async () => {
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

    const workflowError = new Error("Push pull request GitHub failure");

    await expect(
      failCard(trello, project, "card-1", workflowError),
    ).rejects.toBe(workflowError);

    expect(addComment).toHaveBeenCalledWith(
      "card-1",
      [
        "Agent Orchestrator failed.",
        "",
        "Category: Workflow",
        "Reason: Push pull request GitHub failure",
        "",
        "To retry deliberately, move this card to Ready for Agent.",
      ].join("\n"),
    );
  });

  it("uses the category carried by WorkflowError", async () => {
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

    const workflowError = new WorkflowError(
      "OpenCode",
      "agent execution failed",
    );

    await expect(
      failCard(trello, project, "card-1", workflowError),
    ).rejects.toBe(workflowError);

    expect(addComment).toHaveBeenCalledWith(
      "card-1",
      [
        "Agent Orchestrator failed.",
        "",
        "Category: OpenCode",
        "Reason: agent execution failed",
        "",
        "To retry deliberately, move this card to Ready for Agent.",
      ].join("\n"),
    );
  });

  it("uses an explicit Git/GitHub WorkflowError category", async () => {
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

    const workflowError = new WorkflowError(
      "Git/GitHub",
      "remote operation failed",
    );

    await expect(
      failCard(trello, project, "card-1", workflowError),
    ).rejects.toBe(workflowError);

    expect(addComment).toHaveBeenCalledWith(
      "card-1",
      [
        "Agent Orchestrator failed.",
        "",
        "Category: Git/GitHub",
        "Reason: remote operation failed",
        "",
        "To retry deliberately, move this card to Ready for Agent.",
      ].join("\n"),
    );
  });
});
