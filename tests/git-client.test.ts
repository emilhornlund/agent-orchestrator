import { describe, expect, it, vi } from "vitest";

import { GitClient, type RunGit } from "../src/git/git-client.js";

describe("GitClient", () => {
  it("fetches a branch from a remote", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const git = new GitClient(runGit);

    await git.fetch("/repo", "origin", "main");

    expect(runGit).toHaveBeenCalledWith("/repo", ["fetch", "origin", "main"]);
  });

  it("detects an existing branch", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("  agent/card-123");
    const git = new GitClient(runGit);

    await expect(git.branchExists("/repo", "agent/card-123")).resolves.toBe(
      true,
    );
  });

  it("detects a missing branch", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const git = new GitClient(runGit);

    await expect(git.branchExists("/repo", "agent/card-123")).resolves.toBe(
      false,
    );
  });

  it("adds a worktree for an existing branch", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const git = new GitClient(runGit);

    await git.addWorktree("/repo", "/worktrees/card-123", "agent/card-123");

    expect(runGit).toHaveBeenCalledWith("/repo", [
      "worktree",
      "add",
      "/worktrees/card-123",
      "agent/card-123",
    ]);
  });

  it("adds a worktree with a new branch", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const git = new GitClient(runGit);

    await git.addWorktreeWithNewBranch(
      "/repo",
      "/worktrees/card-123",
      "agent/card-123",
      "origin/main",
    );

    expect(runGit).toHaveBeenCalledWith("/repo", [
      "worktree",
      "add",
      "-b",
      "agent/card-123",
      "/worktrees/card-123",
      "origin/main",
    ]);
  });

  it("gets repository status including untracked files", async () => {
    const runGit = vi
      .fn<RunGit>()
      .mockResolvedValue(" M src/main.cpp\n?? new-file.txt");

    const git = new GitClient(runGit);

    const status = await git.getStatus("/worktree");

    expect(runGit).toHaveBeenCalledWith("/worktree", [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);

    expect(status).toBe(" M src/main.cpp\n?? new-file.txt");
  });

  it("detects repository changes", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("?? agent-test.txt");

    const git = new GitClient(runGit);

    await expect(git.hasChanges("/worktree")).resolves.toBe(true);
  });

  it("detects a clean repository", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");

    const git = new GitClient(runGit);

    await expect(git.hasChanges("/worktree")).resolves.toBe(false);
  });

  it("stages all repository changes", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const git = new GitClient(runGit);

    await git.stageAll("/worktree");

    expect(runGit).toHaveBeenCalledWith("/worktree", ["add", "--all"]);
  });

  it("gets staged files", async () => {
    const runGit = vi
      .fn<RunGit>()
      .mockResolvedValue("src/main.cpp\ninclude/RPG/Player.hpp\nold-file.cpp");

    const git = new GitClient(runGit);

    await expect(git.getStagedFiles("/worktree")).resolves.toEqual([
      "src/main.cpp",
      "include/RPG/Player.hpp",
      "old-file.cpp",
    ]);

    expect(runGit).toHaveBeenCalledWith("/worktree", [
      "diff",
      "--cached",
      "--name-only",
    ]);
  });

  it("returns no staged files for an empty index", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const git = new GitClient(runGit);

    await expect(git.getStagedFiles("/worktree")).resolves.toEqual([]);
  });

  it("creates a commit", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const git = new GitClient(runGit);

    await git.commit("/worktree", "Add player inventory");

    expect(runGit).toHaveBeenCalledWith("/worktree", [
      "commit",
      "-m",
      "Add player inventory",
    ]);
  });

  it("gets the current commit SHA", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("abc123def456");

    const git = new GitClient(runGit);

    await expect(git.getHeadSha("/worktree")).resolves.toBe("abc123def456");

    expect(runGit).toHaveBeenCalledWith("/worktree", ["rev-parse", "HEAD"]);
  });
});
