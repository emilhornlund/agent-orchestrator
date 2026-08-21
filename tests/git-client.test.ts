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
});
