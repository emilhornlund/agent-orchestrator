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

  it("gets the current HEAD commit SHA", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("abc123def456");

    const git = new GitClient(runGit);

    await expect(git.getHeadSha("/worktree")).resolves.toBe("abc123def456");

    expect(runGit).toHaveBeenCalledWith("/worktree", ["rev-parse", "HEAD"]);
  });

  it("gets the current branch", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("agent/card-123");

    const git = new GitClient(runGit);

    await expect(git.getCurrentBranch("/worktree")).resolves.toBe(
      "agent/card-123",
    );

    expect(runGit).toHaveBeenCalledWith("/worktree", [
      "branch",
      "--show-current",
    ]);
  });

  it("pushes a branch and configures its upstream", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const git = new GitClient(runGit);

    await git.push("/tmp/repository", "origin", "agent/example");

    expect(runGit).toHaveBeenCalledWith("/tmp/repository", [
      "push",
      "--set-upstream",
      "origin",
      "agent/example",
    ]);
  });

  it("removes a worktree", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const git = new GitClient(runGit);

    await git.removeWorktree("/repo", "/worktrees/card-1");

    expect(runGit).toHaveBeenCalledWith("/repo", [
      "worktree",
      "remove",
      "/worktrees/card-1",
    ]);
  });

  it("deletes a local branch", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const git = new GitClient(runGit);

    await git.deleteBranch("/repo", "agent/card-1");

    expect(runGit).toHaveBeenCalledWith("/repo", [
      "branch",
      "-D",
      "agent/card-1",
    ]);
  });

  it("prunes stale worktree metadata", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const git = new GitClient(runGit);

    await git.pruneWorktrees("/repo");

    expect(runGit).toHaveBeenCalledWith("/repo", ["worktree", "prune"]);
  });

  it("hard-resets a worktree to HEAD", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const git = new GitClient(runGit);

    await git.resetHard("/worktree");

    expect(runGit).toHaveBeenCalledWith("/worktree", [
      "reset",
      "--hard",
      "HEAD",
    ]);
  });

  it("removes untracked files from a worktree", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const git = new GitClient(runGit);

    await git.cleanUntracked("/worktree");

    expect(runGit).toHaveBeenCalledWith("/worktree", ["clean", "-fd"]);
  });
});
