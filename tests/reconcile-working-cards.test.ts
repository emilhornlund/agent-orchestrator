import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import type { GitHubClient } from "../src/github/github-client.js";
import {
  reconcileClaimedCard,
  reconcileWorkingCards,
} from "../src/orchestrator/reconcile-working-cards.js";
import type { EmailNotifier } from "../src/notifications/email-notifier.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

const temporaryDirectories: string[] = [];

const project = {
  id: "project",
  repository: {
    path: "/repo",
    github: "owner/repo",
    worktreeRoot: "/worktrees",
  },
  trello: {
    boardId: "board",
    backlogListId: "backlog",
    readyListId: "ready",
    workingListId: "working",
    reviewListId: "review",
    failedListId: "failed",
    doneListId: "done",
    refinementLabelId: "refinement",
    featureLabelId: "feature",
    improvementLabelId: "improvement",
    bugLabelId: "bug",
  },
} as ProjectConfig;

function card(overrides: Partial<TrelloCard> = {}): TrelloCard {
  return {
    id: "card-1",
    name: "Task",
    desc: "",
    idList: "working",
    idLabels: ["feature"],
    url: "https://trello.example/card-1",
    ...overrides,
  };
}

function transition(listBeforeId: string): {
  id: string;
  date: string;
  listBeforeId: string;
  listAfterId: string;
} {
  return {
    id: "action-1",
    date: "2026-08-30T10:00:00.000Z",
    listBeforeId,
    listAfterId: "working",
  };
}

function createWorktreeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-working-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("reconcileWorkingCards", () => {
  it("leaves a Working card unchanged when transition history lookup fails", async () => {
    const historyError = new Error("Trello unavailable");
    const trello = {
      getCards: vi.fn().mockResolvedValue([card()]),
      getLatestListTransition: vi.fn().mockRejectedValue(historyError),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;

    await expect(
      reconcileWorkingCards(
        trello,
        {} as GitClient,
        {} as GitHubClient,
        project,
      ),
    ).rejects.toBe(historyError);

    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("corrects a Working card with no transition evidence without inspecting GitHub", async () => {
    const moveCard = vi
      .fn()
      .mockResolvedValue({ ...card(), idList: "backlog" });
    const trello = {
      getCards: vi.fn().mockResolvedValue([card()]),
      getLatestListTransition: vi.fn().mockResolvedValue(null),
      moveCard,
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;
    const git = {
      getCurrentBranch: vi.fn(),
    } as unknown as GitClient;
    const github = {
      findPullRequest: vi.fn(),
    } as unknown as GitHubClient;

    await expect(
      reconcileWorkingCards(trello, git, github, project),
    ).resolves.toBeNull();

    expect(moveCard).toHaveBeenCalledWith("card-1", "backlog");
    expect(trello.addComment).toHaveBeenCalledWith(
      "card-1",
      expect.stringContaining("no recorded transition"),
    );
    expect(git.getCurrentBranch).not.toHaveBeenCalled();
    expect(github.findPullRequest).not.toHaveBeenCalled();
  });

  it("recovers a Ready for Agent transition only with an existing expected worktree", async () => {
    const worktreeRoot = createWorktreeRoot();
    const worktreePath = path.join(worktreeRoot, "card-1");
    fs.mkdirSync(worktreePath);
    const configuredProject = {
      ...project,
      repository: { ...project.repository, worktreeRoot },
    } as ProjectConfig;
    const trello = {
      getCards: vi.fn().mockResolvedValue([card()]),
      getLatestListTransition: vi
        .fn()
        .mockResolvedValue(transition(configuredProject.trello.readyListId)),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;
    const git = {
      getCurrentBranch: vi.fn().mockResolvedValue("agent/card-1"),
    } as unknown as GitClient;
    const github = {
      findPullRequest: vi.fn().mockResolvedValue(null),
    } as unknown as GitHubClient;

    await expect(
      reconcileWorkingCards(trello, git, github, configuredProject),
    ).resolves.toEqual({
      card: card(),
      workflow: "implementation",
    });

    expect(trello.getLatestListTransition).toHaveBeenCalledWith(
      "card-1",
      "working",
    );
    expect(git.getCurrentBranch).toHaveBeenCalledWith(worktreePath);
    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("does not resend after a later reconciliation cycle observes the card outside Working", async () => {
    const worktreeRoot = createWorktreeRoot();
    fs.mkdirSync(path.join(worktreeRoot, "card-1"));
    const configuredProject = {
      ...project,
      repository: { ...project.repository, worktreeRoot },
    } as ProjectConfig;
    let listId = configuredProject.trello.workingListId;
    const notifier: EmailNotifier = {
      send: vi.fn(),
    };
    const trello = {
      getCards: vi
        .fn()
        .mockImplementation(async (requestedListId: string) =>
          requestedListId === listId ? [card({ idList: listId })] : [],
        ),
      getLatestListTransition: vi.fn().mockResolvedValue({
        ...transition(configuredProject.trello.readyListId),
        listAfterId: configuredProject.trello.workingListId,
      }),
      moveCard: vi.fn().mockImplementation(async () => {
        listId = configuredProject.trello.reviewListId;
        return { ...card(), idList: listId };
      }),
    } as unknown as TrelloClient;
    const git = {
      getCurrentBranch: vi.fn().mockResolvedValue("agent/card-1"),
      getStatus: vi.fn().mockResolvedValue(""),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      pruneWorktrees: vi.fn().mockResolvedValue(undefined),
      branchExists: vi.fn().mockResolvedValue(false),
    } as unknown as GitClient;
    const github = {
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/owner/repo/pull/1",
      }),
      findChangesRequestedPullRequest: vi.fn().mockResolvedValue(null),
    } as unknown as GitHubClient;

    await reconcileWorkingCards(
      trello,
      git,
      github,
      configuredProject,
      notifier,
    );
    await reconcileWorkingCards(
      trello,
      git,
      github,
      configuredProject,
      notifier,
    );

    expect(notifier.send).toHaveBeenCalledTimes(1);
    expect(trello.moveCard).toHaveBeenCalledTimes(1);
  });

  it("corrects a Ready transition with a worktree on the wrong branch", async () => {
    const worktreeRoot = createWorktreeRoot();
    fs.mkdirSync(path.join(worktreeRoot, "card-1"));
    const configuredProject = {
      ...project,
      repository: { ...project.repository, worktreeRoot },
    } as ProjectConfig;
    const moveCard = vi
      .fn()
      .mockResolvedValue({ ...card(), idList: "backlog" });
    const trello = {
      getCards: vi.fn().mockResolvedValue([card()]),
      getLatestListTransition: vi
        .fn()
        .mockResolvedValue(transition(configuredProject.trello.readyListId)),
      moveCard,
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;
    const git = {
      getCurrentBranch: vi.fn().mockResolvedValue("main"),
    } as unknown as GitClient;
    const github = {
      findPullRequest: vi.fn(),
    } as unknown as GitHubClient;

    await expect(
      reconcileWorkingCards(trello, git, github, configuredProject),
    ).resolves.toBeNull();

    expect(moveCard).toHaveBeenCalledWith("card-1", "backlog");
    expect(github.findPullRequest).not.toHaveBeenCalled();
  });

  it("corrects a manual move from Backlog even when stale artifacts exist", async () => {
    const worktreeRoot = createWorktreeRoot();
    const worktreePath = path.join(worktreeRoot, "card-1");
    fs.mkdirSync(worktreePath);
    const configuredProject = {
      ...project,
      repository: { ...project.repository, worktreeRoot },
    } as ProjectConfig;
    const moveCard = vi
      .fn()
      .mockResolvedValue({ ...card(), idList: "backlog" });
    const trello = {
      getCards: vi.fn().mockResolvedValue([card()]),
      getLatestListTransition: vi
        .fn()
        .mockResolvedValue(transition(configuredProject.trello.backlogListId)),
      moveCard,
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;
    const git = {
      getCurrentBranch: vi.fn(),
    } as unknown as GitClient;
    const github = {
      findPullRequest: vi.fn(),
    } as unknown as GitHubClient;

    await expect(
      reconcileWorkingCards(trello, git, github, configuredProject),
    ).resolves.toBeNull();

    expect(moveCard).toHaveBeenCalledWith("card-1", "backlog");
    expect(git.getCurrentBranch).not.toHaveBeenCalled();
    expect(github.findPullRequest).not.toHaveBeenCalled();
    expect(fs.existsSync(worktreePath)).toBe(true);
  });

  it("never creates a worktree during read-only reconciliation", async () => {
    const worktreeRoot = createWorktreeRoot();
    const configuredProject = {
      ...project,
      repository: { ...project.repository, worktreeRoot },
    } as ProjectConfig;
    const trello = {
      getCards: vi.fn().mockResolvedValue([card()]),
      getLatestListTransition: vi
        .fn()
        .mockResolvedValue(transition(configuredProject.trello.readyListId)),
      moveCard: vi.fn().mockResolvedValue({ ...card(), idList: "backlog" }),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;
    const github = {
      findPullRequest: vi.fn(),
    } as unknown as GitHubClient;

    await reconcileWorkingCards(
      trello,
      {} as GitClient,
      github,
      configuredProject,
    );

    expect(fs.readdirSync(worktreeRoot)).toEqual([]);
    expect(github.findPullRequest).not.toHaveBeenCalled();
  });

  it("recovers a Human Review transition only for actionable requested changes", async () => {
    const trello = {
      getCards: vi.fn().mockResolvedValue([card()]),
      getLatestListTransition: vi.fn().mockResolvedValue(transition("review")),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;
    const github = {
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/owner/repo/pull/1",
      }),
      findChangesRequestedPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/owner/repo/pull/1",
        feedback: "Fix the regression.",
      }),
    } as unknown as GitHubClient;

    await expect(
      reconcileWorkingCards(trello, {} as GitClient, github, project),
    ).resolves.toEqual({
      card: card(),
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
      feedback: "Fix the regression.",
    });

    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it.each(["failed", "done"])(
    "corrects a Working card moved from %s despite a stale PR",
    async (source) => {
      const trello = {
        getCards: vi.fn().mockResolvedValue([card()]),
        getLatestListTransition: vi.fn().mockResolvedValue(transition(source)),
        moveCard: vi.fn().mockResolvedValue({ ...card(), idList: "backlog" }),
        addComment: vi.fn().mockResolvedValue(undefined),
      } as unknown as TrelloClient;
      const github = {
        findPullRequest: vi.fn(),
      } as unknown as GitHubClient;

      await reconcileWorkingCards(trello, {} as GitClient, github, project);

      expect(trello.moveCard).toHaveBeenCalledWith("card-1", "backlog");
      expect(github.findPullRequest).not.toHaveBeenCalled();
    },
  );

  it("blocks the project when multiple recoverable Working cards exist", async () => {
    const first = card();
    const second = card({ id: "card-2", url: "https://trello.example/card-2" });
    const worktreeRoot = createWorktreeRoot();
    fs.mkdirSync(path.join(worktreeRoot, "card-1"));
    fs.mkdirSync(path.join(worktreeRoot, "card-2"));
    const configuredProject = {
      ...project,
      repository: { ...project.repository, worktreeRoot },
    } as ProjectConfig;
    const trello = {
      getCards: vi.fn().mockResolvedValue([first, second]),
      getLatestListTransition: vi
        .fn()
        .mockResolvedValue(transition(configuredProject.trello.readyListId)),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;
    const git = {
      getCurrentBranch: vi
        .fn()
        .mockImplementation(async (worktree: string) =>
          worktree.endsWith("card-1") ? "agent/card-1" : "agent/card-2",
        ),
    } as unknown as GitClient;

    await expect(
      reconcileWorkingCards(
        trello,
        git,
        {
          findPullRequest: vi.fn().mockResolvedValue(null),
        } as unknown as GitHubClient,
        configuredProject,
      ),
    ).rejects.toThrow("Multiple active cards are in Working");
  });
});

describe("reconcileClaimedCard", () => {
  it("keeps a claimed card in Working when its pull-request lookup fails", async () => {
    const lookupError = new Error("GitHub unavailable");
    const trello = {
      moveCard: vi.fn(),
    } as unknown as TrelloClient;
    const github = {
      findPullRequest: vi.fn().mockRejectedValue(lookupError),
    } as unknown as GitHubClient;

    await expect(
      reconcileClaimedCard(trello, {} as GitClient, github, project, card()),
    ).rejects.toMatchObject({
      category: "Git/GitHub",
      cause: lookupError,
    });

    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("keeps a Human Review move-back card unchanged when its pull-request lookup fails", async () => {
    const lookupError = new Error("GitHub unavailable");
    const trello = {
      getCards: vi.fn().mockResolvedValue([card()]),
      getLatestListTransition: vi.fn().mockResolvedValue(transition("review")),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;
    const github = {
      findPullRequest: vi.fn().mockRejectedValue(lookupError),
    } as unknown as GitHubClient;

    await expect(
      reconcileWorkingCards(trello, {} as GitClient, github, project),
    ).rejects.toMatchObject({
      category: "Git/GitHub",
      cause: lookupError,
    });

    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("moves an initially claimed card with an existing PR to Human Review", async () => {
    const cardValue = card();
    const trello = {
      moveCard: vi.fn().mockResolvedValue({ ...cardValue, idList: "review" }),
    } as unknown as TrelloClient;
    const github = {
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/owner/repo/pull/1",
      }),
    } as unknown as GitHubClient;
    const git = {
      pruneWorktrees: vi.fn().mockResolvedValue(undefined),
      branchExists: vi.fn().mockResolvedValue(false),
    } as unknown as GitClient;

    await expect(
      reconcileClaimedCard(trello, git, github, project, cardValue),
    ).resolves.toBe(true);

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "review");
  });

  it("notifies once when an initially claimed card with an existing PR reaches Human Review", async () => {
    const notifier: EmailNotifier = {
      send: vi.fn(async (message) => {
        expect(message.text).toContain("existing pull request");
        expect(message.text).toContain("https://trello.example/card-1");
      }),
    };
    const trello = {
      moveCard: vi.fn().mockResolvedValue({ ...card(), idList: "review" }),
    } as unknown as TrelloClient;
    const github = {
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/owner/repo/pull/1",
      }),
    } as unknown as GitHubClient;
    const git = {
      pruneWorktrees: vi.fn().mockResolvedValue(undefined),
      branchExists: vi.fn().mockResolvedValue(false),
    } as unknown as GitClient;

    await reconcileClaimedCard(trello, git, github, project, card(), notifier);

    expect(notifier.send).toHaveBeenCalledTimes(1);
  });
});
