import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import type { GitHubClient } from "../src/github/github-client.js";
import { getSessionLogPath } from "../src/logging/session-log.js";
import { reconcileReviewCards } from "../src/orchestrator/reconcile-review-cards.js";
import type { TrelloClient } from "../src/trello/trello-client.js";

const project = {
  id: "test-project",
  repository: {
    path: "/repo",
    github: "owner/repo",
  },
  trello: {
    ownershipCustomFieldId: "ownership-field",
    backlogListId: "backlog",
    workingListId: "working",
    reviewListId: "review",
    doneListId: "done",
    failedListId: "failed",
  },
} as ProjectConfig;

const card = {
  id: "card-1",
  name: "Reviewed task",
  desc: "",
  idList: "review",
  url: "https://trello.example/card-1",
  workflowOwnership: JSON.stringify({
    version: 1,
    owner: "agent-orchestrator",
    projectId: "test-project",
    cardId: "card-1",
    workflow: "implementation",
  }),
};

describe("reconcileReviewCards", () => {
  const sessionLogPath = getSessionLogPath(project.id, card.id);

  afterEach(() => {
    rmSync(sessionLogPath, {
      force: true,
    });
  });

  it("does nothing when there are no Human Review cards", async () => {
    const trello = {
      getCards: vi.fn().mockResolvedValue([]),
      clearWorkflowOwnership: vi.fn().mockResolvedValue(undefined),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;

    const git = {} as GitClient;
    const github = {
      findMergedPullRequest: vi.fn(),
    } as unknown as GitHubClient;

    await expect(
      reconcileReviewCards(trello, git, github, project),
    ).resolves.toBeNull();

    expect(trello.getCards).toHaveBeenCalledWith("review", {
      workflowOwnershipCustomFieldId: "ownership-field",
    });
    expect(github.findMergedPullRequest).not.toHaveBeenCalled();
    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("corrects an unowned Human Review card without inspecting GitHub", async () => {
    const moveCard = vi.fn().mockResolvedValue({
      ...card,
      idList: "backlog",
    });
    const clearWorkflowOwnership = vi.fn().mockResolvedValue(undefined);
    const addComment = vi.fn().mockResolvedValue(undefined);
    const trello = {
      getCards: vi
        .fn()
        .mockResolvedValue([{ ...card, workflowOwnership: "not-json" }]),
      clearWorkflowOwnership,
      moveCard,
      addComment,
    } as unknown as TrelloClient;
    const github = {
      findMergedPullRequest: vi.fn(),
      findClosedPullRequest: vi.fn(),
      findPullRequest: vi.fn(),
    } as unknown as GitHubClient;

    await expect(
      reconcileReviewCards(trello, {} as GitClient, github, project),
    ).resolves.toBeNull();

    expect(clearWorkflowOwnership).toHaveBeenCalledWith(
      "card-1",
      "ownership-field",
    );
    expect(moveCard).toHaveBeenCalledWith("card-1", "backlog");
    expect(addComment).toHaveBeenCalledWith(
      "card-1",
      expect.stringContaining("not validly owned"),
    );
    expect(github.findMergedPullRequest).not.toHaveBeenCalled();
    expect(github.findPullRequest).not.toHaveBeenCalled();
  });

  it("blocks the project when multiple owned cards are in Human Review", async () => {
    const secondCard = {
      ...card,
      id: "card-2",
      name: "Another reviewed task",
      url: "https://trello.example/card-2",
      workflowOwnership: JSON.stringify({
        version: 1,
        owner: "agent-orchestrator",
        projectId: "test-project",
        cardId: "card-2",
        workflow: "implementation",
      }),
    };
    const trello = {
      getCards: vi.fn().mockResolvedValue([card, secondCard]),
      moveCard: vi.fn(),
      clearWorkflowOwnership: vi.fn(),
      addComment: vi.fn(),
    } as unknown as TrelloClient;
    const github = {
      findMergedPullRequest: vi.fn(),
    } as unknown as GitHubClient;

    await expect(
      reconcileReviewCards(trello, {} as GitClient, github, project),
    ).rejects.toThrow("Multiple owned cards are active in Human Review");

    expect(github.findMergedPullRequest).not.toHaveBeenCalled();
    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("leaves a Human Review card untouched when its PR is still open", async () => {
    const trello = {
      getCards: vi.fn().mockResolvedValue([card]),
      clearWorkflowOwnership: vi.fn().mockResolvedValue(undefined),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;

    const git = {} as GitClient;

    const github = {
      findMergedPullRequest: vi.fn().mockResolvedValue(null),
      findClosedPullRequest: vi.fn().mockResolvedValue(null),
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/owner/repo/pull/1",
      }),
      findChangesRequestedPullRequest: vi.fn().mockResolvedValue(null),
    } as unknown as GitHubClient;

    await expect(
      reconcileReviewCards(trello, git, github, project),
    ).resolves.toEqual({ card, active: true });

    expect(trello.moveCard).not.toHaveBeenCalled();

    expect(github.findClosedPullRequest).toHaveBeenCalledWith({
      cwd: "/repo",
      repository: "owner/repo",
      headBranch: "agent/card-1",
    });
  });

  it("deletes the remote branch and moves a merged card to Done", async () => {
    mkdirSync(path.dirname(sessionLogPath), {
      recursive: true,
    });

    writeFileSync(sessionLogPath, "OpenCode output", "utf8");

    expect(existsSync(sessionLogPath)).toBe(true);

    const trello = {
      getCards: vi.fn().mockResolvedValue([card]),
      clearWorkflowOwnership: vi.fn().mockResolvedValue(undefined),
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

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "done", {
      dueComplete: true,
    });

    expect(existsSync(sessionLogPath)).toBe(false);
  });

  it("keeps the session log when moving a merged card to Done fails", async () => {
    mkdirSync(path.dirname(sessionLogPath), {
      recursive: true,
    });

    writeFileSync(sessionLogPath, "OpenCode output", "utf8");

    const trello = {
      getCards: vi.fn().mockResolvedValue([card]),
      clearWorkflowOwnership: vi.fn().mockResolvedValue(undefined),
      moveCard: vi.fn().mockRejectedValue(new Error("move failed")),
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

    await expect(
      reconcileReviewCards(trello, git, github, project),
    ).rejects.toThrow("Could not complete merged Human Review card");

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "done", {
      dueComplete: true,
    });

    expect(trello.clearWorkflowOwnership).not.toHaveBeenCalled();

    expect(existsSync(sessionLogPath)).toBe(true);
  });

  it("moves a merged card to Done when the remote branch is already gone", async () => {
    const trello = {
      getCards: vi.fn().mockResolvedValue([card]),
      clearWorkflowOwnership: vi.fn().mockResolvedValue(undefined),
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

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "done", {
      dueComplete: true,
    });
  });

  it("keeps a merged card in Human Review when remote branch cleanup fails", async () => {
    const trello = {
      getCards: vi.fn().mockResolvedValue([card]),
      clearWorkflowOwnership: vi.fn().mockResolvedValue(undefined),
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

    await expect(
      reconcileReviewCards(trello, git, github, project),
    ).rejects.toThrow("Could not clean up merged pull request branch");

    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("moves a card to Failed when its pull request was closed without merge", async () => {
    const trello = {
      getCards: vi.fn().mockResolvedValue([card]),
      clearWorkflowOwnership: vi.fn().mockResolvedValue(undefined),
      moveCard: vi.fn().mockResolvedValue({
        ...card,
        idList: "failed",
      }),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;

    const git = {
      remoteBranchExists: vi.fn(),
      deleteRemoteBranch: vi.fn(),
    } as unknown as GitClient;

    const github = {
      findMergedPullRequest: vi.fn().mockResolvedValue(null),
      findClosedPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/owner/repo/pull/1",
      }),
    } as unknown as GitHubClient;

    await reconcileReviewCards(trello, git, github, project);

    expect(trello.moveCard).toHaveBeenCalledWith(
      "card-1",
      project.trello.failedListId,
    );

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

  it("keeps processing safely when moving a closed pull request card to Failed fails", async () => {
    const trello = {
      getCards: vi.fn().mockResolvedValue([card]),
      clearWorkflowOwnership: vi.fn().mockResolvedValue(undefined),
      moveCard: vi.fn().mockRejectedValue(new Error("move failed")),
      addComment: vi.fn(),
    } as unknown as TrelloClient;

    const git = {} as GitClient;

    const github = {
      findMergedPullRequest: vi.fn().mockResolvedValue(null),
      findClosedPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/owner/repo/pull/1",
      }),
    } as unknown as GitHubClient;

    await expect(
      reconcileReviewCards(trello, git, github, project),
    ).rejects.toThrow("Could not move closed Human Review card to Failed");

    expect(trello.addComment).not.toHaveBeenCalled();
  });

  it("moves a Human Review card to Working and returns requested review feedback", async () => {
    const trello = {
      getCards: vi.fn().mockResolvedValue([card]),
      clearWorkflowOwnership: vi.fn().mockResolvedValue(undefined),
      moveCard: vi.fn().mockResolvedValue({
        ...card,
        idList: "working",
      }),
    } as unknown as TrelloClient;

    const git = {} as GitClient;

    const github = {
      findMergedPullRequest: vi.fn().mockResolvedValue(null),
      findClosedPullRequest: vi.fn().mockResolvedValue(null),
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/owner/repo/pull/1",
      }),
      findChangesRequestedPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/owner/repo/pull/1",
        feedback: "Please add a regression test.",
      }),
    } as unknown as GitHubClient;

    const result = await reconcileReviewCards(trello, git, github, project);

    expect(trello.moveCard).toHaveBeenCalledWith(
      "card-1",
      project.trello.workingListId,
    );

    expect(result).toEqual({
      card,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
      feedback: "Please add a regression test.",
    });
  });
});
