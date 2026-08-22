import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import type { GitHubClient } from "../src/github/github-client.js";
import {
  reconcileClaimedCard,
  reconcileWorkingCards,
} from "../src/orchestrator/reconcile-working-cards.js";
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
    failedListId: "failed",
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

  it("moves a Working card to Failed when no open PR exists", async () => {
    const card = {
      id: "card-1",
      name: "Stranded task",
      desc: "",
      idList: "working",
      url: "https://trello.example/card-1",
    };

    const trello = {
      getCards: vi.fn().mockResolvedValue([card]),
      moveCard: vi.fn().mockResolvedValue({
        ...card,
        idList: "failed",
      }),
    } as unknown as TrelloClient;

    const git = {} as GitClient;

    const github = {
      findPullRequest: vi.fn().mockResolvedValue(null),
    } as unknown as GitHubClient;

    await reconcileWorkingCards(trello, git, github, project);

    expect(trello.moveCard).toHaveBeenCalledTimes(1);

    expect(trello.moveCard).toHaveBeenCalledWith(
      "card-1",
      project.trello.failedListId,
    );
  });

  it("preserves local task state when moving a stranded Working card to Failed", async () => {
    const card = {
      id: "card-1",
      name: "Interrupted task",
      desc: "",
      idList: "working",
      url: "https://trello.example/card-1",
    };

    const trello = {
      getCards: vi.fn().mockResolvedValue([card]),
      moveCard: vi.fn().mockResolvedValue({
        ...card,
        idList: "failed",
      }),
    } as unknown as TrelloClient;

    const git = {
      getStatus: vi.fn(),
      removeWorktree: vi.fn(),
      pruneWorktrees: vi.fn(),
      branchExists: vi.fn(),
      deleteBranch: vi.fn(),
      resetHard: vi.fn(),
      cleanUntracked: vi.fn(),
    } as unknown as GitClient;

    const github = {
      findPullRequest: vi.fn().mockResolvedValue(null),
    } as unknown as GitHubClient;

    await reconcileWorkingCards(trello, git, github, project);

    expect(git.getStatus).not.toHaveBeenCalled();
    expect(git.removeWorktree).not.toHaveBeenCalled();
    expect(git.pruneWorktrees).not.toHaveBeenCalled();
    expect(git.deleteBranch).not.toHaveBeenCalled();
    expect(git.resetHard).not.toHaveBeenCalled();
    expect(git.cleanUntracked).not.toHaveBeenCalled();
  });

  it("continues reconciling other cards when moving a stranded card to Failed fails", async () => {
    const firstCard = {
      id: "card-1",
      name: "Failed move",
      desc: "",
      idList: "working",
      url: "https://trello.example/card-1",
    };

    const secondCard = {
      id: "card-2",
      name: "Another stranded task",
      desc: "",
      idList: "working",
      url: "https://trello.example/card-2",
    };

    const trello = {
      getCards: vi.fn().mockResolvedValue([firstCard, secondCard]),
      moveCard: vi
        .fn()
        .mockRejectedValueOnce(new Error("Trello unavailable"))
        .mockResolvedValueOnce({
          ...secondCard,
          idList: "failed",
        }),
    } as unknown as TrelloClient;

    const git = {} as GitClient;

    const github = {
      findPullRequest: vi.fn().mockResolvedValue(null),
    } as unknown as GitHubClient;

    await reconcileWorkingCards(trello, git, github, project);

    expect(trello.moveCard).toHaveBeenCalledTimes(2);

    expect(trello.moveCard).toHaveBeenNthCalledWith(1, "card-1", "failed");

    expect(trello.moveCard).toHaveBeenNthCalledWith(2, "card-2", "failed");
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

  it("does not reconcile a claimed card when no open PR exists", async () => {
    const card = {
      id: "card-1",
      name: "Retry task",
      desc: "",
      idList: "working",
      url: "https://trello.example/card-1",
    };

    const trello = {
      moveCard: vi.fn(),
    } as unknown as TrelloClient;

    const git = {} as GitClient;

    const github = {
      findPullRequest: vi.fn().mockResolvedValue(null),
    } as unknown as GitHubClient;

    const result = await reconcileClaimedCard(
      trello,
      git,
      github,
      project,
      card,
    );

    expect(result).toBe(false);

    expect(github.findPullRequest).toHaveBeenCalledWith({
      cwd: "/repo",
      repository: "owner/repo",
      headBranch: "agent/card-1",
    });

    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("moves a claimed card directly to Human Review when an open PR exists", async () => {
    const card = {
      id: "card-1",
      name: "Already published task",
      desc: "",
      idList: "working",
      url: "https://trello.example/card-1",
    };

    const trello = {
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

    const result = await reconcileClaimedCard(
      trello,
      git,
      github,
      project,
      card,
    );

    expect(result).toBe(true);

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "review");
  });

  it("keeps a claimed card reconciled when local cleanup fails", async () => {
    const card = {
      id: "card-1",
      name: "Already published task",
      desc: "",
      idList: "working",
      url: "https://trello.example/card-1",
    };

    const trello = {
      moveCard: vi.fn().mockResolvedValue({
        ...card,
        idList: "review",
      }),
    } as unknown as TrelloClient;

    const git = {
      pruneWorktrees: vi.fn().mockRejectedValue(new Error("prune failed")),
    } as unknown as GitClient;

    const github = {
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/owner/repo/pull/1",
      }),
    } as unknown as GitHubClient;

    await expect(
      reconcileClaimedCard(trello, git, github, project, card),
    ).resolves.toBe(true);

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "review");
  });
});
