import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import type { GitHubClient } from "../src/github/github-client.js";
import { reconcileWorkingCards } from "../src/orchestrator/reconcile-working-cards.js";
import type { TrelloClient } from "../src/trello/trello-client.js";

const project = {
  id: "test-project",
  repository: {
    path: "/repo",
    github: "owner/repo",
    worktreeRoot: "/worktrees",
  },
  trello: {
    workingListId: "working",
    reviewListId: "review",
  },
} as ProjectConfig;

describe("reconcileWorkingCards", () => {
  it("does nothing when there are no Working cards", async () => {
    const trello = {
      getCards: vi.fn().mockResolvedValue([]),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;

    const git = {} as GitClient;
    const github = {
      findPullRequest: vi.fn(),
    } as unknown as GitHubClient;

    await reconcileWorkingCards(trello, git, github, project);

    expect(trello.getCards).toHaveBeenCalledWith("working");
    expect(github.findPullRequest).not.toHaveBeenCalled();
    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("moves a Working card to Human Review when an open PR exists", async () => {
    const card = {
      id: "card-1",
      name: "Recovered task",
      desc: "",
      idList: "working",
      url: "https://trello.example/card-1",
    };

    const trello = {
      getCards: vi.fn().mockResolvedValue([card]),
      moveCard: vi.fn().mockResolvedValue({
        ...card,
        idList: "review",
      }),
    } as unknown as TrelloClient;

    const git = {
      pruneWorktrees: vi.fn().mockResolvedValue(undefined),
      branchExists: vi.fn().mockResolvedValue(false),
    } as unknown as GitClient;

    const github = {
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/owner/repo/pull/1",
      }),
    } as unknown as GitHubClient;

    await reconcileWorkingCards(trello, git, github, project);

    expect(github.findPullRequest).toHaveBeenCalledWith({
      cwd: "/repo",
      repository: "owner/repo",
      headBranch: "agent/card-1",
    });

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "review");
  });

  it("leaves a Working card untouched when no open PR exists", async () => {
    const card = {
      id: "card-1",
      name: "Stranded task",
      desc: "",
      idList: "working",
      url: "https://trello.example/card-1",
    };

    const trello = {
      getCards: vi.fn().mockResolvedValue([card]),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;

    const git = {} as GitClient;

    const github = {
      findPullRequest: vi.fn().mockResolvedValue(null),
    } as unknown as GitHubClient;

    await reconcileWorkingCards(trello, git, github, project);

    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("continues reconciling other cards when one PR lookup fails", async () => {
    const firstCard = {
      id: "card-1",
      name: "Broken lookup",
      desc: "",
      idList: "working",
      url: "https://trello.example/card-1",
    };

    const secondCard = {
      id: "card-2",
      name: "Recoverable task",
      desc: "",
      idList: "working",
      url: "https://trello.example/card-2",
    };

    const trello = {
      getCards: vi.fn().mockResolvedValue([firstCard, secondCard]),
      moveCard: vi.fn().mockResolvedValue(secondCard),
    } as unknown as TrelloClient;

    const git = {
      pruneWorktrees: vi.fn().mockResolvedValue(undefined),
      branchExists: vi.fn().mockResolvedValue(false),
    } as unknown as GitClient;

    const github = {
      findPullRequest: vi
        .fn()
        .mockRejectedValueOnce(new Error("GitHub unavailable"))
        .mockResolvedValueOnce({
          url: "https://github.com/owner/repo/pull/2",
        }),
    } as unknown as GitHubClient;

    await reconcileWorkingCards(trello, git, github, project);

    expect(trello.moveCard).toHaveBeenCalledTimes(1);
    expect(trello.moveCard).toHaveBeenCalledWith("card-2", "review");
  });
});
