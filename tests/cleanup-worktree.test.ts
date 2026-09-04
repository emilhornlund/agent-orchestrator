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
    defaultBranch: "main",
    worktreeRoot: "/worktrees",
  },
} as ProjectConfig;

describe("cleanupWorktree", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes the worktree and local branch", async () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (candidate) => candidate === "/worktrees/card-1",
    );
    vi.mocked(fs.lstatSync).mockReturnValue({
      isSymbolicLink: () => false,
    } as fs.Stats);

    const git = {
      getCurrentBranch: vi.fn().mockResolvedValue("agent/card-1"),
      getRebaseState: vi.fn().mockResolvedValue(null),
      getConflictedPaths: vi.fn().mockResolvedValue([]),
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
    vi.mocked(fs.existsSync).mockImplementation(
      (candidate) => candidate === "/worktrees/card-1",
    );
    vi.mocked(fs.lstatSync).mockReturnValue({
      isSymbolicLink: () => false,
    } as fs.Stats);

    const git = {
      getCurrentBranch: vi.fn().mockResolvedValue("agent/card-1"),
      getRebaseState: vi.fn().mockResolvedValue(null),
      getConflictedPaths: vi.fn().mockResolvedValue([]),
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
        preserveRecoveryState: true,
      }),
    ).rejects.toThrow("Refusing to remove dirty worktree");

    expect(git.removeWorktree).not.toHaveBeenCalled();
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  it("refuses to remove a worktree with an active rebase", async () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (candidate) => candidate === "/worktrees/card-1",
    );
    vi.mocked(fs.lstatSync).mockReturnValue({
      isSymbolicLink: () => false,
    } as fs.Stats);

    const git = {
      getCurrentBranch: vi.fn().mockResolvedValue("agent/card-1"),
      getRebaseState: vi.fn().mockResolvedValue({ active: true }),
      getConflictedPaths: vi.fn(),
      getStatus: vi.fn(),
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
        preserveRecoveryState: true,
      }),
    ).rejects.toThrow("active rebase");

    expect(git.removeWorktree).not.toHaveBeenCalled();
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  it("refuses to remove a worktree with unmerged paths", async () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (candidate) => candidate === "/worktrees/card-1",
    );
    vi.mocked(fs.lstatSync).mockReturnValue({
      isSymbolicLink: () => false,
    } as fs.Stats);

    const git = {
      getCurrentBranch: vi.fn().mockResolvedValue("agent/card-1"),
      getRebaseState: vi.fn().mockResolvedValue(null),
      getConflictedPaths: vi.fn().mockResolvedValue(["src/conflicted.ts"]),
      getStatus: vi.fn(),
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
        preserveRecoveryState: true,
      }),
    ).rejects.toThrow("unmerged paths");

    expect(git.removeWorktree).not.toHaveBeenCalled();
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  it("cleans up a branch even when the worktree directory is already gone", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.lstatSync).mockReturnValue(undefined);

    const git = {
      getCurrentBranch: vi.fn(),
      getRebaseState: vi.fn(),
      getConflictedPaths: vi.fn(),
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

  it("refuses to clean a worktree on the wrong branch", async () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (candidate) => candidate === "/worktrees/card-1",
    );
    vi.mocked(fs.lstatSync).mockReturnValue({
      isSymbolicLink: () => false,
    } as fs.Stats);

    const git = {
      getCurrentBranch: vi.fn().mockResolvedValue("agent/other-card"),
      getRebaseState: vi.fn(),
      getConflictedPaths: vi.fn(),
      getStatus: vi.fn(),
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
        preserveRecoveryState: true,
      }),
    ).rejects.toThrow('on branch "agent/other-card"');

    expect(git.getStatus).not.toHaveBeenCalled();
    expect(git.removeWorktree).not.toHaveBeenCalled();
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  it("refuses to clean a path outside the configured worktree root", async () => {
    const git = {
      getCurrentBranch: vi.fn(),
      getRebaseState: vi.fn(),
      getConflictedPaths: vi.fn(),
      getStatus: vi.fn(),
      removeWorktree: vi.fn(),
      pruneWorktrees: vi.fn(),
      branchExists: vi.fn(),
      deleteBranch: vi.fn(),
    } as unknown as GitClient;

    await expect(
      cleanupWorktree({
        git,
        project,
        worktreePath: "/worktrees/../sensitive",
        branch: "agent/card-1",
      }),
    ).rejects.toThrow("outside configured root");

    expect(git.getCurrentBranch).not.toHaveBeenCalled();
    expect(git.pruneWorktrees).not.toHaveBeenCalled();
  });

  it("refuses to clean a nested path under the configured worktree root", async () => {
    const git = {
      getCurrentBranch: vi.fn(),
      getRebaseState: vi.fn(),
      getConflictedPaths: vi.fn(),
      getStatus: vi.fn(),
      removeWorktree: vi.fn(),
      pruneWorktrees: vi.fn(),
      branchExists: vi.fn(),
      deleteBranch: vi.fn(),
    } as unknown as GitClient;

    await expect(
      cleanupWorktree({
        git,
        project,
        worktreePath: "/worktrees/project/card-1",
        branch: "agent/card-1",
      }),
    ).rejects.toThrow("expected card path");

    expect(git.pruneWorktrees).not.toHaveBeenCalled();
  });

  it("preserves a worktree protected by a prepared-conflict handoff", async () => {
    const handoffPath =
      "/worktrees/.orchestrator/prepared-conflicts/test-project/card-1.json";
    vi.mocked(fs.existsSync).mockImplementation(
      (candidate) =>
        candidate === "/worktrees/card-1" || candidate === handoffPath,
    );
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        kind: "prepared-conflict",
        projectId: "test-project",
        cardId: "card-1",
        taskBranch: "agent/card-1",
        defaultBranch: "main",
        expectedRemoteTaskSha: "a".repeat(40),
        conflictedPaths: ["src/conflicted.ts"],
        rebase: {
          active: true,
          backend: "merge",
          headName: "refs/heads/agent/card-1",
          onto: "b".repeat(40),
          originalHead: "a".repeat(40),
        },
        preparedAt: "2026-09-01T13:42:03.000Z",
      }),
    );

    const git = {
      getCurrentBranch: vi.fn(),
      getRebaseState: vi.fn(),
      getConflictedPaths: vi.fn(),
      getStatus: vi.fn(),
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
        preserveRecoveryState: true,
      }),
    ).rejects.toThrow("prepared-conflict handoff");

    expect(git.removeWorktree).not.toHaveBeenCalled();
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  it("refuses to clean a symbolic-link path", async () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (candidate) => candidate === "/worktrees/card-1",
    );
    vi.mocked(fs.lstatSync).mockReturnValue({
      isSymbolicLink: () => true,
    } as fs.Stats);

    const git = {
      getCurrentBranch: vi.fn(),
      getRebaseState: vi.fn(),
      getConflictedPaths: vi.fn(),
      getStatus: vi.fn(),
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
    ).rejects.toThrow("symbolic-link");

    expect(git.getCurrentBranch).not.toHaveBeenCalled();
    expect(git.pruneWorktrees).not.toHaveBeenCalled();
  });

  it("refuses to delete a branch unrelated to the worktree path", async () => {
    const git = {
      getCurrentBranch: vi.fn(),
      getStatus: vi.fn(),
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
        branch: "agent/other-card",
      }),
    ).rejects.toThrow("unexpected branch");

    expect(git.pruneWorktrees).not.toHaveBeenCalled();
  });

  it("stops before destructive operations when shutdown occurs during inspection", async () => {
    const controller = new AbortController();
    vi.mocked(fs.existsSync).mockImplementation(
      (candidate) => candidate === "/worktrees/card-1",
    );
    vi.mocked(fs.lstatSync).mockReturnValue({
      isSymbolicLink: () => false,
    } as fs.Stats);

    const git = {
      getCurrentBranch: vi.fn().mockResolvedValue("agent/card-1"),
      getRebaseState: vi.fn().mockResolvedValue(null),
      getConflictedPaths: vi.fn().mockResolvedValue([]),
      getStatus: vi.fn().mockImplementation(async () => {
        controller.abort();
        return "";
      }),
      removeWorktree: vi.fn(),
      pruneWorktrees: vi.fn(),
      branchExists: vi.fn(),
      deleteBranch: vi.fn(),
    } as unknown as GitClient;

    await cleanupWorktree({
      git,
      project,
      worktreePath: "/worktrees/card-1",
      branch: "agent/card-1",
      signal: controller.signal,
    });

    expect(git.removeWorktree).not.toHaveBeenCalled();
    expect(git.pruneWorktrees).not.toHaveBeenCalled();
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });
});
