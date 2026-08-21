import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { GitClient, type RunGit } from "../src/git/git-client.js";
import { GitHubClient, type RunGitHub } from "../src/github/github-client.js";
import { publishCard } from "../src/orchestrator/publish-card.js";
import { type TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

function createProject(): ProjectConfig {
  return {
    id: "example",
    trello: {
      boardId: "board",
      readyListId: "ready",
      workingListId: "working",
      reviewListId: "review",
      doneListId: "done",
    },
    repository: {
      path: "/tmp/example-repository",
      github: "example/repository",
      defaultBranch: "main",
      worktreeRoot: "/tmp/example-worktrees",
    },
    opencode: {
      model: "test-model",
      variant: "test-variant",
    },
  };
}

function createCard(): TrelloCard {
  return {
    id: "card-1",
    name: "Example task",
    desc: "Implement the example task",
    idList: "working",
    url: "https://trello.com/c/card-1",
  };
}

describe("publishCard", () => {
  it("pushes, creates the PR, and moves the card in order", async () => {
    const events: string[] = [];
    const runGit = vi.fn<RunGit>(async () => {
      events.push("push");
      return "";
    });
    const runGitHub = vi.fn<RunGitHub>(async () => {
      events.push("pr");
      return { url: "https://github.com/example/repository/pull/123" };
    });
    const trello = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });
    const moveCard = vi
      .spyOn(trello, "moveCard")
      .mockImplementation(async () => {
        events.push("move");
        return createCard();
      });

    await publishCard({
      trello,
      git: new GitClient(runGit),
      github: new GitHubClient(runGitHub),
      project: createProject(),
      card: createCard(),
      worktreePath: "/tmp/example-worktrees/card-1",
      branch: "agent/card-1",
    });

    expect(events).toEqual(["push", "pr", "move"]);
    expect(runGit).toHaveBeenCalledWith("/tmp/example-worktrees/card-1", [
      "push",
      "--set-upstream",
      "origin",
      "agent/card-1",
    ]);
    expect(runGitHub).toHaveBeenCalledWith({
      cwd: "/tmp/example-worktrees/card-1",
      repository: "example/repository",
      baseBranch: "main",
      headBranch: "agent/card-1",
      title: "Example task",
      body: [
        "Trello: https://trello.com/c/card-1",
        "",
        "Implemented automatically by Agent Orchestrator.",
      ].join("\n"),
    });
    expect(moveCard).toHaveBeenCalledWith("card-1", "review");
  });

  it("stops before PR creation when pushing fails", async () => {
    const runGit = vi.fn<RunGit>().mockRejectedValue(new Error("push failed"));
    const runGitHub = vi.fn<RunGitHub>();
    const trello = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });
    const moveCard = vi.spyOn(trello, "moveCard");

    await expect(
      publishCard({
        trello,
        git: new GitClient(runGit),
        github: new GitHubClient(runGitHub),
        project: createProject(),
        card: createCard(),
        worktreePath: "/tmp/example-worktrees/card-1",
        branch: "agent/card-1",
      }),
    ).rejects.toThrow("push failed");

    expect(runGitHub).not.toHaveBeenCalled();
    expect(moveCard).not.toHaveBeenCalled();
  });

  it("stops before moving the card when PR creation fails", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const runGitHub = vi
      .fn<RunGitHub>()
      .mockRejectedValue(new Error("PR creation failed"));
    const trello = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });
    const moveCard = vi.spyOn(trello, "moveCard");

    await expect(
      publishCard({
        trello,
        git: new GitClient(runGit),
        github: new GitHubClient(runGitHub),
        project: createProject(),
        card: createCard(),
        worktreePath: "/tmp/example-worktrees/card-1",
        branch: "agent/card-1",
      }),
    ).rejects.toThrow("PR creation failed");

    expect(runGit).toHaveBeenCalledOnce();
    expect(moveCard).not.toHaveBeenCalled();
  });
});
