import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import type { GitHubClient } from "../src/github/github-client.js";
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

describe("reconcileReviewCards", () => {
  it("returns requested changes without an ownership marker", async () => {
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

    await expect(
      reconcileReviewCards(trello, {} as GitClient, github, project),
    ).resolves.toEqual({ card: card(), active: true });

    expect(trello.moveCard).not.toHaveBeenCalled();
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
    const trello = trelloFor(card());
    const git = {
      remoteBranchExists: vi.fn().mockResolvedValue(true),
      deleteRemoteBranch: vi.fn().mockResolvedValue(undefined),
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
    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "done", {
      dueComplete: true,
    });
  });

  it("moves a closed unmerged expected PR to Failed and comments", async () => {
    const trello = trelloFor(card());

    await reconcileReviewCards(
      trello,
      {} as GitClient,
      githubFor("card-1", "closed"),
      project,
    );

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "failed");
    expect(trello.addComment).toHaveBeenCalledWith(
      "card-1",
      expect.stringContaining("closed without being merged"),
    );
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

    await expect(
      reconcileReviewCards(trello, {} as GitClient, github, project),
    ).rejects.toThrow("Multiple active cards are in Human Review");
    expect(trello.moveCard).not.toHaveBeenCalled();
  });
});
