import fs from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { cleanupWorktree } from "../src/git/cleanup-worktree.js";
import { GitClient } from "../src/git/git-client.js";

vi.mock("node:fs");

const project = {
  id: "test-project",
  repository: {
    path: "/repo",
  },
} as ProjectConfig;

describe("cleanupWorktree", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes the worktree and local branch", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const git = {
      getStatus: vi.fn().mockResolvedValue(""),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      pruneWorktrees: vi.fn().mockResolvedValue(undefined),
      branchExists: vi.fn().mockResolvedValue(true),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
    } as unknown as GitClient;

    await cleanupWorktree({
      git,
      project,
      worktreePath: "/worktrees/card-1",
      branch: "agent/card-1",
    });

    expect(git.removeWorktree).toHaveBeenCalledWith(
      "/repo",
      "/worktrees/card-1",
    );
    expect(git.pruneWorktrees).toHaveBeenCalledWith("/repo");
    expect(git.deleteBranch).toHaveBeenCalledWith("/repo", "agent/card-1");
  });

  it("refuses to remove a dirty worktree", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const git = {
      getStatus: vi.fn().mockResolvedValue(" M src/example.ts"),
      removeWorktree: vi.fn(),
      pruneWorktrees: vi.fn(),
      branchExists: vi.fn(),
      deleteBranch: vi.fn(),
    } as unknown as GitClient;

    await expect(
      cleanupWorktree({
        git,
        project,
        worktreePath: "/worktrees/card-1",
        branch: "agent/card-1",
      }),
    ).rejects.toThrow("Refusing to remove dirty worktree");

    expect(git.removeWorktree).not.toHaveBeenCalled();
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  it("cleans up a branch even when the worktree directory is already gone", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const git = {
      getStatus: vi.fn(),
      removeWorktree: vi.fn(),
      pruneWorktrees: vi.fn().mockResolvedValue(undefined),
      branchExists: vi.fn().mockResolvedValue(true),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
    } as unknown as GitClient;

    await cleanupWorktree({
      git,
      project,
      worktreePath: "/worktrees/card-1",
      branch: "agent/card-1",
    });

    expect(git.getStatus).not.toHaveBeenCalled();
    expect(git.removeWorktree).not.toHaveBeenCalled();
    expect(git.pruneWorktrees).toHaveBeenCalledWith("/repo");
    expect(git.deleteBranch).toHaveBeenCalledWith("/repo", "agent/card-1");
  });
});
