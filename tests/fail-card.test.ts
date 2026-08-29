import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { OpenCodeTimeoutError } from "../src/opencode/opencode-client.js";
import { failCard } from "../src/orchestrator/fail-card.js";
import { WorkflowError } from "../src/orchestrator/workflow-error.js";
import { TrelloClient } from "../src/trello/trello-client.js";

const project: ProjectConfig = {
  id: "example",
  trello: {
    boardId: "board",
    readyListId: "ready",
    workingListId: "working",
    reviewListId: "review",
    failedListId: "failed",
    doneListId: "done",
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

    expect(moveCard).toHaveBeenCalledWith("card-1", "failed");

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
      url: "https://trello.com/c/card-1",
    });

    vi.spyOn(trello, "addComment").mockRejectedValue(
      new Error("comment failed"),
    );

    const workflowError = new Error("implementation failed");

    await expect(
      failCard(trello, project, "card-1", workflowError),
    ).rejects.toBe(workflowError);
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
    }
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

  it("labels repository validation failures explicitly", async () => {
    const trello = new TrelloClient({
      apiKey: "key",
      token: "token",
    });

    vi.spyOn(trello, "moveCard").mockResolvedValue({
      id: "card-1",
      name: "Card",
      desc: "",
      idList: "failed",
      url: "https://trello.com/c/card-1",
    });

    const addComment = vi.spyOn(trello, "addComment").mockResolvedValue({
      id: "action-1",
      type: "commentCard",
      date: "2026-08-22T09:00:00.000Z",
    });

    const validationError = new WorkflowError(
      "Validation",
      "Repository validation exited with code 1",
    );

    await expect(
      failCard(trello, project, "card-1", validationError),
    ).rejects.toBe(validationError);

    expect(addComment).toHaveBeenCalledWith(
      "card-1",
      [
        "Agent Orchestrator failed.",
        "",
        "Category: Validation",
        "Reason: Repository validation exited with code 1",
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
      url: "https://trello.com/c/card-1",
    });

    const addComment = vi.spyOn(trello, "addComment").mockResolvedValue({
      id: "action-1",
      type: "commentCard",
      date: "2026-08-22T09:00:00.000Z",
    });

    const workflowError = new Error(
      "Repository validation push pull request GitHub failure",
    );

    await expect(
      failCard(trello, project, "card-1", workflowError),
    ).rejects.toBe(workflowError);

    expect(addComment).toHaveBeenCalledWith(
      "card-1",
      [
        "Agent Orchestrator failed.",
        "",
        "Category: Workflow",
        "Reason: Repository validation push pull request GitHub failure",
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
