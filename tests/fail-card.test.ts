import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import {
  appendSessionLog,
  getSessionLogPath,
  removeSessionLog,
} from "../src/logging/session-log.js";
import { OpenCodeTimeoutError } from "../src/opencode/opencode-client.js";
import { failCard } from "../src/orchestrator/fail-card.js";
import { WorkflowError } from "../src/orchestrator/workflow-error.js";
import { TrelloClient } from "../src/trello/trello-client.js";

const project: ProjectConfig = {
  id: "example",
  trello: {
    boardId: "board",
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
    path: "/tmp/repository",
    github: "example/repository",
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

function getDailyLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);

  return path.join(process.cwd(), "logs", `test-orchestrator-${date}.log`);
}

describe("failCard", () => {
  it("moves the card to Failed and rethrows the workflow error", async () => {
    const trello = new TrelloClient({
      apiKey: "key",
      token: "token",
    });

    const moveCard = vi.spyOn(trello, "moveCard").mockResolvedValue({
      id: "card-1",
      name: "Card",
      desc: "",
      idList: "failed",
      idLabels: [],
      url: "https://trello.com/c/card-1",
    });

    const addComment = vi.spyOn(trello, "addComment").mockResolvedValue({
      id: "action-1",
      type: "commentCard",
      date: "2026-08-22T09:00:00.000Z",
    });

    const workflowError = new Error("implementation failed");

    await expect(
      failCard(trello, project, "card-1", workflowError),
    ).rejects.toBe(workflowError);

    expect(moveCard).toHaveBeenCalledWith("card-1", "failed-list");

    expect(addComment).toHaveBeenCalledWith(
      "card-1",
      [
        "Agent Orchestrator failed.",
        "",
        "Category: Workflow",
        "Reason: implementation failed",
        "",
        "To retry, move this card to Ready.",
      ].join("\n"),
    );
  });

  it("preserves the workflow error when adding the failure comment fails", async () => {
    const trello = new TrelloClient({
      apiKey: "key",
      token: "token",
    });

    vi.spyOn(trello, "moveCard").mockResolvedValue({
      id: "card-1",
      name: "Card",
      desc: "",
      idList: "failed",
      idLabels: [],
      url: "https://trello.com/c/card-1",
    });

    vi.spyOn(trello, "addComment").mockRejectedValue(
      new Error("comment failed"),
    );

    const workflowError = new Error("implementation failed");

    await expect(
      failCard(trello, project, "card-1", workflowError),
    ).rejects.toBe(workflowError);

    expect(fs.readFileSync(getDailyLogPath(), "utf8")).toContain(
      "Failure handling incomplete: card moved to Failed, but adding the failure comment failed: comment failed; preserving the primary failure",
    );
  });

  it("preserves both errors when moving to Failed also fails", async () => {
    const trello = new TrelloClient({
      apiKey: "key",
      token: "token",
    });

    const moveError = new Error("Trello unavailable");

    vi.spyOn(trello, "moveCard").mockRejectedValue(moveError);

    const workflowError = new Error("implementation failed");

    try {
      await failCard(trello, project, "card-1", workflowError);

      throw new Error("Expected failCard to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);

      const aggregate = error as AggregateError;

      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]).toBe(workflowError);
      expect(aggregate.errors[1]).toBe(moveError);
      expect(aggregate.cause).toBe(moveError);
      expect(aggregate.message).toContain("implementation failed");
      expect(aggregate.message).toContain("Trello unavailable");

      expect(fs.readFileSync(getDailyLogPath(), "utf8")).toContain(
        "Failure handling failed: could not move card to Failed: Trello unavailable; preserving the primary failure and skipping the failure comment",
      );
    }
  });

  it("logs the category, reason, and retained session log for a failed card", async () => {
    const trello = new TrelloClient({
      apiKey: "key",
      token: "token",
    });

    vi.spyOn(trello, "moveCard").mockResolvedValue({
      id: "card-session-log",
      name: "Card",
      desc: "",
      idList: "failed",
      idLabels: [],
      url: "https://trello.com/c/card-session-log",
    });
    vi.spyOn(trello, "addComment").mockResolvedValue({
      id: "action-1",
      type: "commentCard",
      date: "2026-08-22T09:00:00.000Z",
    });

    const sessionLogPath = getSessionLogPath(project.id, "card-session-log");

    try {
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
        `[example] [card:card-session-log] Task failed. Category: Setup; Reason: Repository setup exited with code 1; Session log: ${sessionLogPath}; attempting to move card to Failed`,
      );
      expect(dailyLog).toContain(
        "Failure handling: card moved to Failed; adding failure comment",
      );
      expect(dailyLog).not.toContain("OpenCode output remains here");
    } finally {
      removeSessionLog(project.id, "card-session-log");
    }
  });

  it("uses a readable reason for a non-Error failure", async () => {
    const trello = new TrelloClient({
      apiKey: "key",
      token: "token",
    });

    vi.spyOn(trello, "moveCard").mockResolvedValue({
      id: "card-non-error",
      name: "Card",
      desc: "",
      idList: "failed",
      idLabels: [],
      url: "https://trello.com/c/card-non-error",
    });

    const addComment = vi.spyOn(trello, "addComment").mockResolvedValue({
      id: "action-1",
      type: "commentCard",
      date: "2026-08-22T09:00:00.000Z",
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
    const trello = new TrelloClient({
      apiKey: "key",
      token: "token",
    });

    vi.spyOn(trello, "moveCard").mockResolvedValue({
      id: "card-1",
      name: "Card",
      desc: "",
      idList: "failed",
      idLabels: [],
      url: "https://trello.com/c/card-1",
    });

    const addComment = vi.spyOn(trello, "addComment").mockResolvedValue({
      id: "action-1",
      type: "commentCard",
      date: "2026-08-22T09:00:00.000Z",
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
        "To retry, move this card to Ready.",
      ].join("\n"),
    );
  });

  it("does not infer failure categories from arbitrary error messages", async () => {
    const trello = new TrelloClient({
      apiKey: "key",
      token: "token",
    });

    vi.spyOn(trello, "moveCard").mockResolvedValue({
      id: "card-1",
      name: "Card",
      desc: "",
      idList: "failed",
      idLabels: [],
      url: "https://trello.com/c/card-1",
    });

    const addComment = vi.spyOn(trello, "addComment").mockResolvedValue({
      id: "action-1",
      type: "commentCard",
      date: "2026-08-22T09:00:00.000Z",
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
        "To retry, move this card to Ready.",
      ].join("\n"),
    );
  });

  it("uses the category carried by WorkflowError", async () => {
    const trello = new TrelloClient({
      apiKey: "key",
      token: "token",
    });

    vi.spyOn(trello, "moveCard").mockResolvedValue({
      id: "card-1",
      name: "Card",
      desc: "",
      idList: "failed",
      idLabels: [],
      url: "https://trello.com/c/card-1",
    });

    const addComment = vi.spyOn(trello, "addComment").mockResolvedValue({
      id: "action-1",
      type: "commentCard",
      date: "2026-08-22T09:00:00.000Z",
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
        "To retry, move this card to Ready.",
      ].join("\n"),
    );
  });

  it("uses the Git/GitHub workflow category explicitly", async () => {
    const trello = new TrelloClient({
      apiKey: "key",
      token: "token",
    });

    vi.spyOn(trello, "moveCard").mockResolvedValue({
      id: "card-1",
      name: "Card",
      desc: "",
      idList: "failed",
      idLabels: [],
      url: "https://trello.com/c/card-1",
    });

    const addComment = vi.spyOn(trello, "addComment").mockResolvedValue({
      id: "action-1",
      type: "commentCard",
      date: "2026-08-22T09:00:00.000Z",
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
        "To retry, move this card to Ready.",
      ].join("\n"),
    );
  });
});
