import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import type { GitHubClient } from "../src/github/github-client.js";
import { reconcileReviewCards } from "../src/orchestrator/reconcile-review-cards.js";
import type { TrelloClient } from "../src/trello/trello-client.js";

const project = {
  id: "test-project",
  repository: {
    path: "/repo",
    github: "owner/repo",
  },
  trello: {
    reviewListId: "review",
    doneListId: "done",
  },
} as ProjectConfig;

const card = {
  id: "card-1",
  name: "Reviewed task",
  desc: "",
  idList: "review",
  url: "https://trello.example/card-1",
};

describe("reconcileReviewCards", () => {
  it("does nothing when there are no Human Review cards", async () => {
    const trello = {
      getCards: vi.fn().mockResolvedValue([]),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;

    const git = {} as GitClient;
    const github = {
      findMergedPullRequest: vi.fn(),
    } as unknown as GitHubClient;

    await reconcileReviewCards(trello, git, github, project);

    expect(trello.getCards).toHaveBeenCalledWith("review");
    expect(github.findMergedPullRequest).not.toHaveBeenCalled();
    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("leaves a Human Review card untouched when its PR is not merged", async () => {
    const trello = {
      getCards: vi.fn().mockResolvedValue([card]),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;

    const git = {} as GitClient;

    const github = {
      findMergedPullRequest: vi.fn().mockResolvedValue(null),
    } as unknown as GitHubClient;

    await reconcileReviewCards(trello, git, github, project);

    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("deletes the remote branch and moves a merged card to Done", async () => {
    const trello = {
      getCards: vi.fn().mockResolvedValue([card]),
      moveCard: vi.fn().mockResolvedValue({
        ...card,
        idList: "done",
      }),
    } as unknown as TrelloClient;

    const git = {
      remoteBranchExists: vi.fn().mockResolvedValue(true),
      deleteRemoteBranch: vi.fn().mockResolvedValue(undefined),
    } as unknown as GitClient;

    const github = {
      findMergedPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/owner/repo/pull/1",
      }),
    } as unknown as GitHubClient;

    await reconcileReviewCards(trello, git, github, project);

    expect(git.deleteRemoteBranch).toHaveBeenCalledWith(
      "/repo",
      "origin",
      "agent/card-1",
    );

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "done");
  });

  it("moves a merged card to Done when the remote branch is already gone", async () => {
    const trello = {
      getCards: vi.fn().mockResolvedValue([card]),
      moveCard: vi.fn().mockResolvedValue({
        ...card,
        idList: "done",
      }),
    } as unknown as TrelloClient;

    const git = {
      remoteBranchExists: vi.fn().mockResolvedValue(false),
      deleteRemoteBranch: vi.fn(),
    } as unknown as GitClient;

    const github = {
      findMergedPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/owner/repo/pull/1",
      }),
    } as unknown as GitHubClient;

    await reconcileReviewCards(trello, git, github, project);

    expect(git.deleteRemoteBranch).not.toHaveBeenCalled();

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "done");
  });

  it("keeps a merged card in Human Review when remote branch cleanup fails", async () => {
    const trello = {
      getCards: vi.fn().mockResolvedValue([card]),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;

    const git = {
      remoteBranchExists: vi.fn().mockResolvedValue(true),
      deleteRemoteBranch: vi.fn().mockRejectedValue(new Error("delete failed")),
    } as unknown as GitClient;

    const github = {
      findMergedPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/owner/repo/pull/1",
      }),
    } as unknown as GitHubClient;

    await reconcileReviewCards(trello, git, github, project);

    expect(trello.moveCard).not.toHaveBeenCalled();
  });
});
