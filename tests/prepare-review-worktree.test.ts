import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { GitClient, type RunGit } from "../src/git/git-client.js";
import { prepareReviewWorktree } from "../src/git/prepare-review-worktree.js";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-review-"),
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
      gitIdentity: {
        name: "Agent Orchestrator",
        email: "agent-orchestrator@users.noreply.github.com",
      },
    },
    trello: {
      boardId: "board",
      readyListId: "ready",
      workingListId: "working",
      reviewListId: "review",
      failedListId: "failed",
      doneListId: "done",
    },
    opencode: {
      implementation: {
        model: "implementation-model",
        variant: "implementation-variant",
      },
      review: {
        model: "review-model",
        variant: "review-variant",
      },
      remediation: {
        model: "remediation-model",
        variant: "remediation-variant",
      },
      commit: {
        model: "commit-model",
        variant: "commit-variant",
      },
      timeoutMinutes: 360,
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

describe("prepareReviewWorktree", () => {
  it("creates the worktree from the existing remote PR branch", async () => {
    const worktreeRoot = createTemporaryDirectory();
    const project = createProject(worktreeRoot);

    const runGit = vi.fn<RunGit>(async (_cwd, args) => {
      if (args[0] === "branch" && args[1] === "--list") {
        return "";
      }

      return "";
    });

    const git = new GitClient(runGit);

    const result = await prepareReviewWorktree(git, project, "card-123");

    expect(result).toEqual({
      path: path.join(worktreeRoot, "card-123"),
      branch: "agent/card-123",
    });

    expect(runGit).toHaveBeenNthCalledWith(1, "/repositories/test-project", [
      "fetch",
      "origin",
      "agent/card-123",
    ]);

    expect(runGit).toHaveBeenNthCalledWith(2, "/repositories/test-project", [
      "worktree",
      "prune",
    ]);

    expect(runGit).toHaveBeenNthCalledWith(3, "/repositories/test-project", [
      "branch",
      "--list",
      "agent/card-123",
    ]);

    expect(runGit).toHaveBeenNthCalledWith(4, "/repositories/test-project", [
      "worktree",
      "add",
      "-b",
      "agent/card-123",
      path.join(worktreeRoot, "card-123"),
      "origin/agent/card-123",
    ]);
  });

  it("resets an existing review worktree to the remote PR branch", async () => {
    const worktreeRoot = createTemporaryDirectory();
    const worktreePath = path.join(worktreeRoot, "card-123");

    fs.mkdirSync(worktreePath);

    const project = createProject(worktreeRoot);

    const runGit = vi.fn<RunGit>(async (_cwd, args) => {
      if (args[0] === "branch" && args[1] === "--show-current") {
        return "agent/card-123";
      }

      if (args[0] === "status") {
        return "";
      }

      return "";
    });

    const git = new GitClient(runGit);

    await prepareReviewWorktree(git, project, "card-123");

    expect(runGit).toHaveBeenNthCalledWith(1, "/repositories/test-project", [
      "fetch",
      "origin",
      "agent/card-123",
    ]);

    expect(runGit).toHaveBeenNthCalledWith(2, worktreePath, [
      "branch",
      "--show-current",
    ]);

    expect(runGit).toHaveBeenNthCalledWith(3, worktreePath, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);

    expect(runGit).toHaveBeenNthCalledWith(4, worktreePath, [
      "reset",
      "--hard",
      "origin/agent/card-123",
    ]);

    expect(runGit).toHaveBeenNthCalledWith(5, worktreePath, ["clean", "-fd"]);

    expect(runGit).toHaveBeenNthCalledWith(6, worktreePath, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
  });

  it("preserves an existing dirty review worktree", async () => {
    const worktreeRoot = createTemporaryDirectory();
    const worktreePath = path.join(worktreeRoot, "card-123");

    fs.mkdirSync(worktreePath);

    const project = createProject(worktreeRoot);

    const runGit = vi.fn<RunGit>(async (_cwd, args) => {
      if (args[0] === "branch" && args[1] === "--show-current") {
        return "agent/card-123";
      }

      if (args[0] === "status") {
        return " M src/example.ts";
      }

      return "";
    });

    const git = new GitClient(runGit);

    await expect(
      prepareReviewWorktree(git, project, "card-123"),
    ).resolves.toEqual({
      path: worktreePath,
      branch: "agent/card-123",
    });

    expect(runGit).not.toHaveBeenCalledWith(worktreePath, [
      "reset",
      "--hard",
      "origin/agent/card-123",
    ]);
    expect(runGit).not.toHaveBeenCalledWith(worktreePath, ["clean", "-fd"]);
  });
});
