import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { GitClient, type RunGit } from "../src/git/git-client.js";
import { prepareWorktree } from "../src/git/prepare-worktree.js";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-"),
  );

  temporaryDirectories.push(directory);

  return directory;
}

function createProject(worktreeRoot: string): ProjectConfig {
  return {
    id: "test-project",
    repository: {
      path: "/repositories/test-project",
      github: "example/test-project",
      defaultBranch: "main",
      worktreeRoot,
      validationCommand: "yarn validate",
    },
    trello: {
      boardId: "board",
      readyListId: "ready",
      workingListId: "working",
      reviewListId: "review",
      doneListId: "done",
    },
    opencode: {
      model: "test-model",
      variant: "test-variant",
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
});

describe("prepareWorktree", () => {
  it("creates a new branch and worktree from the default branch", async () => {
    const worktreeRoot = createTemporaryDirectory();
    const project = createProject(worktreeRoot);

    const runGit = vi.fn<RunGit>(async (_cwd, args) => {
      if (args[0] === "branch") {
        return "";
      }

      return "";
    });

    const git = new GitClient(runGit);

    const result = await prepareWorktree(git, project, "card-123");

    expect(result).toEqual({
      path: path.join(worktreeRoot, "card-123"),
      branch: "agent/card-123",
    });

    expect(runGit).toHaveBeenNthCalledWith(1, "/repositories/test-project", [
      "fetch",
      "origin",
      "main",
    ]);

    expect(runGit).toHaveBeenNthCalledWith(2, "/repositories/test-project", [
      "branch",
      "--list",
      "agent/card-123",
    ]);

    expect(runGit).toHaveBeenNthCalledWith(3, "/repositories/test-project", [
      "worktree",
      "add",
      "-b",
      "agent/card-123",
      path.join(worktreeRoot, "card-123"),
      "origin/main",
    ]);
  });

  it("reuses an existing branch when creating the worktree", async () => {
    const worktreeRoot = createTemporaryDirectory();
    const project = createProject(worktreeRoot);

    const runGit = vi.fn<RunGit>(async (_cwd, args) => {
      if (args[0] === "branch") {
        return "  agent/card-123";
      }

      return "";
    });

    const git = new GitClient(runGit);

    await prepareWorktree(git, project, "card-123");

    expect(runGit).toHaveBeenNthCalledWith(3, "/repositories/test-project", [
      "worktree",
      "add",
      path.join(worktreeRoot, "card-123"),
      "agent/card-123",
    ]);
  });

  it("reuses an existing worktree", async () => {
    const worktreeRoot = createTemporaryDirectory();
    const worktreePath = path.join(worktreeRoot, "card-123");

    fs.mkdirSync(worktreePath);

    const project = createProject(worktreeRoot);
    const runGit = vi.fn<RunGit>();
    const git = new GitClient(runGit);

    const result = await prepareWorktree(git, project, "card-123");

    expect(result).toEqual({
      path: worktreePath,
      branch: "agent/card-123",
    });

    expect(runGit).not.toHaveBeenCalled();
  });
});
