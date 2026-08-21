import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { GitClient, type RunGit } from "../src/git/git-client.js";
import {
  GitHubClient,
  type RunGitHubCommand,
} from "../src/github/github-client.js";
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
      failedListId: "failed",
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

    const runGitHubCommand = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      if (args[0] === "pr" && args[1] === "list") {
        events.push("find-pr");
        return "";
      }

      events.push("create-pr");
      return "https://github.com/example/repository/pull/123";
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
      github: new GitHubClient(runGitHubCommand),
      project: createProject(),
      card: createCard(),
      worktreePath: "/tmp/example-worktrees/card-1",
      branch: "agent/card-1",
    });

    expect(events).toEqual(["push", "find-pr", "create-pr", "move"]);

    expect(runGit).toHaveBeenCalledWith("/tmp/example-worktrees/card-1", [
      "push",
      "--set-upstream",
      "origin",
      "agent/card-1",
    ]);

    expect(runGitHubCommand).toHaveBeenNthCalledWith(
      1,
      "/tmp/example-worktrees/card-1",
      [
        "pr",
        "list",
        "--repo",
        "example/repository",
        "--head",
        "agent/card-1",
        "--state",
        "open",
        "--json",
        "url",
        "--limit",
        "1",
        "--jq",
        '.[0].url // ""',
      ],
    );

    expect(runGitHubCommand).toHaveBeenNthCalledWith(
      2,
      "/tmp/example-worktrees/card-1",
      [
        "pr",
        "create",
        "--repo",
        "example/repository",
        "--base",
        "main",
        "--head",
        "agent/card-1",
        "--title",
        "Example task",
        "--body",
        [
          "Trello: https://trello.com/c/card-1",
          "",
          "Implemented automatically by Agent Orchestrator.",
        ].join("\n"),
      ],
    );

    expect(moveCard).toHaveBeenCalledWith("card-1", "review");
  });

  it("reuses an existing pull request instead of creating another one", async () => {
    const events: string[] = [];

    const runGit = vi.fn<RunGit>(async () => {
      events.push("push");
      return "";
    });

    const runGitHubCommand = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      if (args[0] === "pr" && args[1] === "list") {
        events.push("find-pr");
        return "https://github.com/example/repository/pull/123";
      }

      throw new Error("PR creation should not have been called");
    });

    const trello = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });

    vi.spyOn(trello, "moveCard").mockImplementation(async () => {
      events.push("move");
      return createCard();
    });

    await publishCard({
      trello,
      git: new GitClient(runGit),
      github: new GitHubClient(runGitHubCommand),
      project: createProject(),
      card: createCard(),
      worktreePath: "/tmp/example-worktrees/card-1",
      branch: "agent/card-1",
    });

    expect(events).toEqual(["push", "find-pr", "move"]);

    expect(runGitHubCommand).toHaveBeenCalledTimes(1);
  });

  it("stops before PR lookup when pushing fails", async () => {
    const runGit = vi.fn<RunGit>().mockRejectedValue(new Error("push failed"));

    const runGitHubCommand = vi.fn<RunGitHubCommand>();

    const trello = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });

    const moveCard = vi.spyOn(trello, "moveCard");

    await expect(
      publishCard({
        trello,
        git: new GitClient(runGit),
        github: new GitHubClient(runGitHubCommand),
        project: createProject(),
        card: createCard(),
        worktreePath: "/tmp/example-worktrees/card-1",
        branch: "agent/card-1",
      }),
    ).rejects.toThrow("push failed");

    expect(runGitHubCommand).not.toHaveBeenCalled();
    expect(moveCard).not.toHaveBeenCalled();
  });

  it("stops before moving the card when PR creation fails", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");

    const runGitHubCommand = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      if (args[0] === "pr" && args[1] === "list") {
        return "";
      }

      throw new Error("PR creation failed");
    });

    const trello = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });

    const moveCard = vi.spyOn(trello, "moveCard");

    await expect(
      publishCard({
        trello,
        git: new GitClient(runGit),
        github: new GitHubClient(runGitHubCommand),
        project: createProject(),
        card: createCard(),
        worktreePath: "/tmp/example-worktrees/card-1",
        branch: "agent/card-1",
      }),
    ).rejects.toThrow("PR creation failed");

    expect(runGitHubCommand).toHaveBeenCalledTimes(2);
    expect(moveCard).not.toHaveBeenCalled();
  });

  it("stops before PR creation and card movement when PR lookup fails", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const lookupError = new Error("PR lookup failed");
    const runGitHubCommand = vi
      .fn<RunGitHubCommand>()
      .mockRejectedValue(lookupError);

    const trello = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });
    const moveCard = vi.spyOn(trello, "moveCard");

    await expect(
      publishCard({
        trello,
        git: new GitClient(runGit),
        github: new GitHubClient(runGitHubCommand),
        project: createProject(),
        card: createCard(),
        worktreePath: "/tmp/example-worktrees/card-1",
        branch: "agent/card-1",
      }),
    ).rejects.toBe(lookupError);

    expect(runGitHubCommand).toHaveBeenCalledTimes(1);
    expect(moveCard).not.toHaveBeenCalled();
  });

  it("propagates a Human Review move failure after publishing", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const runGitHubCommand = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      if (args[0] === "pr" && args[1] === "list") {
        return "https://github.com/example/repository/pull/123";
      }

      throw new Error("PR creation should not have been called");
    });
    const reviewError = new Error("Human Review move failed");

    const trello = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });
    const moveCard = vi
      .spyOn(trello, "moveCard")
      .mockRejectedValue(reviewError);

    await expect(
      publishCard({
        trello,
        git: new GitClient(runGit),
        github: new GitHubClient(runGitHubCommand),
        project: createProject(),
        card: createCard(),
        worktreePath: "/tmp/example-worktrees/card-1",
        branch: "agent/card-1",
      }),
    ).rejects.toBe(reviewError);

    expect(runGitHubCommand).toHaveBeenCalledTimes(1);
    expect(moveCard).toHaveBeenCalledWith("card-1", "review");
  });
});
