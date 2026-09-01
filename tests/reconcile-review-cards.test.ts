import { existsSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import type { GitHubClient } from "../src/github/github-client.js";
import { Logger } from "../src/logging/logger.js";
import { getFailureContext } from "../src/orchestrator/failure-diagnostic.js";
import {
  appendSessionLog,
  getSessionLogPath,
  removeSessionLog,
} from "../src/logging/session-log.js";
import type { EmailNotifier } from "../src/notifications/email-notifier.js";
import { reconcileReviewCards } from "../src/orchestrator/reconcile-review-cards.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

const project = {
  id: "project",
  repository: {
    path: "/repo",
    github: "owner/repo",
  },
  trello: {
    boardId: "board",
    backlogListId: "backlog",
    readyListId: "ready",
    workingListId: "working",
    reviewListId: "review",
    failedListId: "failed",
    doneListId: "done",
  },
} as ProjectConfig;

function card(id = "card-1"): TrelloCard {
  return {
    id,
    name: id,
    desc: "",
    idList: "review",
    idLabels: [],
    url: `https://trello.example/${id}`,
  };
}

function githubFor(
  cardId: string,
  state: "none" | "open" | "requested" | "closed" | "merged",
): GitHubClient {
  const pullRequest = {
    url: `https://github.com/owner/repo/pull/${cardId === "card-1" ? 1 : 2}`,
  };

  return {
    findMergedPullRequest: vi
      .fn()
      .mockResolvedValue(state === "merged" ? pullRequest : null),
    findClosedPullRequest: vi
      .fn()
      .mockResolvedValue(state === "closed" ? pullRequest : null),
    findPullRequest: vi
      .fn()
      .mockResolvedValue(
        state === "open" || state === "requested" ? pullRequest : null,
      ),
    findChangesRequestedPullRequest: vi
      .fn()
      .mockResolvedValue(
        state === "requested"
          ? { ...pullRequest, feedback: "Fix this." }
          : null,
      ),
  } as unknown as GitHubClient;
}

function trelloFor(cardValue: TrelloCard): TrelloClient {
  return {
    getCards: vi.fn().mockResolvedValue([cardValue]),
    moveCard: vi
      .fn()
      .mockImplementation(async (_cardId: string, listId: string) => ({
        ...cardValue,
        idList: listId,
      })),
    addComment: vi.fn().mockResolvedValue(undefined),
  } as unknown as TrelloClient;
}

afterEach(() => {
  removeSessionLog(project.id, "card-1");
});

describe("reconcileReviewCards", () => {
  it("returns requested changes from Human Review", async () => {
    const trello = trelloFor(card());
    const github = githubFor("card-1", "requested");

    await expect(
      reconcileReviewCards(trello, {} as GitClient, github, project),
    ).resolves.toEqual({
      card: card(),
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
      feedback: "Fix this.",
    });

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "working");
  });

  it("leaves an open PR without requested changes in Human Review", async () => {
    const trello = trelloFor(card());
    const github = githubFor("card-1", "open");
    const event = vi.spyOn(Logger.prototype, "event");

    await expect(
      reconcileReviewCards(trello, {} as GitClient, github, project),
    ).resolves.toEqual({ card: card(), active: true });

    expect(trello.moveCard).not.toHaveBeenCalled();
    expect(event).not.toHaveBeenCalledWith("Human Review card remains active");
    event.mockRestore();
  });

  it("moves a card with no expected PR to Backlog", async () => {
    const trello = {
      ...trelloFor(card()),
      moveCard: vi.fn().mockResolvedValue({ ...card(), idList: "backlog" }),
    } as unknown as TrelloClient;
    const github = githubFor("card-1", "none");

    await expect(
      reconcileReviewCards(trello, {} as GitClient, github, project),
    ).resolves.toBeNull();

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "backlog");
    expect(trello.addComment).toHaveBeenCalledWith(
      "card-1",
      expect.stringContaining("no expected pull request"),
    );
  });

  it("moves a merged expected PR to Done and removes its remote branch", async () => {
    const sessionLogPath = getSessionLogPath(project.id, "card-1");
    appendSessionLog(sessionLogPath, "OpenCode output");

    const events: string[] = [];
    const trello = {
      ...trelloFor(card()),
      moveCard: vi.fn().mockImplementation(async () => {
        events.push(
          existsSync(sessionLogPath)
            ? "move with session log"
            : "move without session log",
        );

        return { ...card(), idList: "done" };
      }),
    } as unknown as TrelloClient;
    const git = {
      remoteBranchExists: vi.fn().mockImplementation(async () => {
        events.push("branch exists");

        return true;
      }),
      deleteRemoteBranch: vi.fn().mockImplementation(async () => {
        events.push("branch deleted");
      }),
    } as unknown as GitClient;

    await reconcileReviewCards(
      trello,
      git,
      githubFor("card-1", "merged"),
      project,
    );

    expect(git.deleteRemoteBranch).toHaveBeenCalledWith(
      "/repo",
      "origin",
      "agent/card-1",
    );
    expect(events).toEqual([
      "branch exists",
      "branch deleted",
      "move with session log",
    ]);
    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "done", {
      dueComplete: true,
    });
    expect(existsSync(sessionLogPath)).toBe(false);
  });

  it("moves a merged expected PR to Done when its remote branch is already absent", async () => {
    const trello = trelloFor(card());
    const git = {
      remoteBranchExists: vi.fn().mockResolvedValue(false),
      deleteRemoteBranch: vi.fn(),
    } as unknown as GitClient;

    await reconcileReviewCards(
      trello,
      git,
      githubFor("card-1", "merged"),
      project,
    );

    expect(git.deleteRemoteBranch).not.toHaveBeenCalled();
    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "done", {
      dueComplete: true,
    });
  });

  it("does not delete a merged remote branch after shutdown", async () => {
    const controller = new AbortController();
    const trello = trelloFor(card());
    const git = {
      remoteBranchExists: vi.fn().mockImplementation(async () => {
        controller.abort();
        return true;
      }),
      deleteRemoteBranch: vi.fn(),
    } as unknown as GitClient;

    await expect(
      reconcileReviewCards(
        trello,
        git,
        githubFor("card-1", "merged"),
        project,
        {},
        undefined,
        controller.signal,
      ),
    ).resolves.toBeNull();

    expect(git.deleteRemoteBranch).not.toHaveBeenCalled();
    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("reports merged remote-branch cleanup failures without moving the card to Done", async () => {
    const sessionLogPath = getSessionLogPath(project.id, "card-1");
    appendSessionLog(sessionLogPath, "OpenCode output");

    const trello = trelloFor(card());
    const deleteError = new Error("delete failed");
    const git = {
      remoteBranchExists: vi.fn().mockResolvedValue(true),
      deleteRemoteBranch: vi.fn().mockRejectedValue(deleteError),
    } as unknown as GitClient;

    await expect(
      reconcileReviewCards(trello, git, githubFor("card-1", "merged"), project),
    ).rejects.toMatchObject({
      category: "Git/GitHub",
      cause: deleteError,
      message: expect.stringContaining(
        "Could not clean up merged pull request branch",
      ),
    });

    expect(trello.moveCard).not.toHaveBeenCalled();
    expect(existsSync(sessionLogPath)).toBe(true);
  });

  it("keeps a Human Review card unchanged when GitHub reconciliation fails", async () => {
    const lookupError = new Error("GitHub unavailable");
    const trello = trelloFor(card());
    const github = {
      findMergedPullRequest: vi.fn().mockRejectedValue(lookupError),
    } as unknown as GitHubClient;

    await expect(
      reconcileReviewCards(trello, {} as GitClient, github, project),
    ).rejects.toMatchObject({
      category: "Git/GitHub",
      cause: lookupError,
    });

    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("keeps the session log when moving a merged card to Done fails", async () => {
    const sessionLogPath = getSessionLogPath(project.id, "card-1");
    appendSessionLog(sessionLogPath, "OpenCode output");

    const moveError = new Error("move failed");
    const trello = {
      ...trelloFor(card()),
      moveCard: vi.fn().mockRejectedValue(moveError),
    } as unknown as TrelloClient;
    const git = {
      remoteBranchExists: vi.fn().mockResolvedValue(false),
      deleteRemoteBranch: vi.fn(),
    } as unknown as GitClient;

    await expect(
      reconcileReviewCards(trello, git, githubFor("card-1", "merged"), project),
    ).rejects.toMatchObject({
      category: "Workflow",
      cause: moveError,
      message: expect.stringContaining(
        "Could not complete merged Human Review card",
      ),
    });

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "done", {
      dueComplete: true,
    });
    expect(existsSync(sessionLogPath)).toBe(true);
  });

  it("moves a closed unmerged expected PR to Failed and comments", async () => {
    const trello = trelloFor(card());
    const git = {
      remoteBranchExists: vi.fn(),
      deleteRemoteBranch: vi.fn(),
    } as unknown as GitClient;

    await reconcileReviewCards(
      trello,
      git,
      githubFor("card-1", "closed"),
      project,
    );

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "failed");
    expect(trello.addComment).toHaveBeenCalledWith(
      "card-1",
      [
        "Pull request was closed without being merged.",
        "",
        "Pull request: https://github.com/owner/repo/pull/1",
      ].join("\n"),
    );
    expect(git.remoteBranchExists).not.toHaveBeenCalled();
    expect(git.deleteRemoteBranch).not.toHaveBeenCalled();
  });

  it("sends a Failed email after closed unmerged reconciliation", async () => {
    const notifier: EmailNotifier = {
      send: vi.fn(async (message) => {
        expect(message.subject).toContain("Failed");
        expect(message.text).toContain(
          "Pull request https://github.com/owner/repo/pull/1 was closed without being merged.",
        );
        expect(message.text).toContain(
          "To retry deliberately, move this card to Ready for Agent.",
        );
      }),
    };
    const trello = trelloFor(card());

    await reconcileReviewCards(
      trello,
      {} as GitClient,
      githubFor("card-1", "closed"),
      project,
      {},
      notifier,
    );

    expect(notifier.send).toHaveBeenCalledTimes(1);
    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "failed");
  });

  it("does not let a closed-card email failure alter reconciliation", async () => {
    const notifier: EmailNotifier = {
      send: vi.fn().mockRejectedValue(new Error("SMTP unavailable")),
    };
    const trello = trelloFor(card());

    await expect(
      reconcileReviewCards(
        trello,
        {} as GitClient,
        githubFor("card-1", "closed"),
        project,
        {},
        notifier,
      ),
    ).resolves.toBeNull();

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "failed");
    expect(trello.addComment).toHaveBeenCalled();
  });

  it("reports the primary failure when moving a closed PR card to Failed fails", async () => {
    const moveError = new Error("move failed");
    const trello = {
      ...trelloFor(card()),
      moveCard: vi.fn().mockRejectedValue(moveError),
      addComment: vi.fn(),
    } as unknown as TrelloClient;

    await expect(
      reconcileReviewCards(
        trello,
        {} as GitClient,
        githubFor("card-1", "closed"),
        project,
      ),
    ).rejects.toMatchObject({
      category: "Workflow",
      cause: moveError,
      message: expect.stringContaining(
        "Could not move closed Human Review card to Failed",
      ),
    });

    expect(trello.addComment).not.toHaveBeenCalled();
  });

  it("blocks the project when multiple expected PRs are active", async () => {
    const second = card("card-2");
    const trello = {
      getCards: vi.fn().mockResolvedValue([card(), second]),
      moveCard: vi.fn(),
      addComment: vi.fn(),
    } as unknown as TrelloClient;
    const github = {
      findMergedPullRequest: vi.fn().mockResolvedValue(null),
      findClosedPullRequest: vi.fn().mockResolvedValue(null),
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/owner/repo/pull/1",
      }),
      findChangesRequestedPullRequest: vi.fn().mockResolvedValue(null),
    } as unknown as GitHubClient;

    try {
      await reconcileReviewCards(trello, {} as GitClient, github, project);
      throw new Error("Expected reconciliation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Multiple active cards are in Human Review",
      );
      expect(getFailureContext(error)).toMatchObject({
        projectId: "project",
        cardIds: ["card-1", "card-2"],
      });
    }
    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("reconciles terminal cards without counting them as active", async () => {
    const mergedCard = card("card-1");
    const activeCard = card("card-2");
    const trello = {
      getCards: vi.fn().mockResolvedValue([mergedCard, activeCard]),
      moveCard: vi.fn().mockResolvedValue(undefined),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;
    const git = {
      remoteBranchExists: vi.fn().mockResolvedValue(false),
    } as unknown as GitClient;
    const github = {
      findMergedPullRequest: vi
        .fn()
        .mockImplementation(async ({ headBranch }: { headBranch: string }) =>
          headBranch === "agent/card-1"
            ? { url: "https://github.com/owner/repo/pull/1" }
            : null,
        ),
      findClosedPullRequest: vi.fn().mockResolvedValue(null),
      findPullRequest: vi
        .fn()
        .mockImplementation(async ({ headBranch }: { headBranch: string }) =>
          headBranch === "agent/card-2"
            ? { url: "https://github.com/owner/repo/pull/2" }
            : null,
        ),
      findChangesRequestedPullRequest: vi.fn().mockResolvedValue(null),
    } as unknown as GitHubClient;

    await expect(
      reconcileReviewCards(trello, git, github, project),
    ).resolves.toEqual({ card: activeCard, active: true });

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "done", {
      dueComplete: true,
    });
    expect(trello.moveCard).not.toHaveBeenCalledWith("card-2", "working");
  });
});
