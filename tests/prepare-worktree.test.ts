import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import {
  GitClient,
  type GitRebaseState,
  type RunGit,
} from "../src/git/git-client.js";
import {
  getExistingPreparedConflictWorktree,
  getExistingWorktree,
  prepareWorktree,
} from "../src/git/prepare-worktree.js";

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
    autoMerge: false,
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
      backlogListId: "backlog-list",
      readyListId: "ready-list",
      workingListId: "working-list",
      reviewListId: "review-list",
      failedListId: "failed-list",
      doneListId: "done-list",
      refinementLabelId: "refinement-label",
      featureLabelId: "feature-label",
      improvementLabelId: "improvement-label",
      bugLabelId: "bug-label",
    },
    opencode: {
      refinement: {
        model: "openai/refinement-model",
        variant: "xhigh",
      },
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
        maxPasses: 1,
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
      reused: false,
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

  it("reuses an existing clean worktree on the expected branch", async () => {
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

    const result = await prepareWorktree(git, project, "card-123");

    expect(result).toEqual({
      path: worktreePath,
      branch: "agent/card-123",
      reused: true,
      initialStatus: "",
    });

    expect(runGit).toHaveBeenNthCalledWith(1, worktreePath, [
      "branch",
      "--show-current",
    ]);

    expect(runGit).toHaveBeenNthCalledWith(2, worktreePath, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
  });

  it("rejects an existing worktree on the wrong branch", async () => {
    const worktreeRoot = createTemporaryDirectory();
    const worktreePath = path.join(worktreeRoot, "card-123");

    fs.mkdirSync(worktreePath);

    const project = createProject(worktreeRoot);

    const runGit = vi.fn<RunGit>(async (_cwd, args) => {
      if (args[0] === "branch" && args[1] === "--show-current") {
        return "main";
      }

      return "";
    });

    const git = new GitClient(runGit);

    await expect(prepareWorktree(git, project, "card-123")).rejects.toThrow(
      `Existing worktree ${worktreePath} is on branch "main", expected "agent/card-123"`,
    );
  });

  it("preserves an existing dirty worktree when retrying", async () => {
    const worktreeRoot = createTemporaryDirectory();
    const worktreePath = path.join(worktreeRoot, "card-123");

    fs.mkdirSync(worktreePath);

    const project = createProject(worktreeRoot);

    const runGit = vi.fn<RunGit>(async (_cwd, args) => {
      if (args[0] === "branch" && args[1] === "--show-current") {
        return "agent/card-123";
      }

      if (args[0] === "status") {
        return " M src/example.ts\n?? src/new-file.ts";
      }

      return "";
    });

    const git = new GitClient(runGit);

    const result = await prepareWorktree(git, project, "card-123");

    expect(result).toEqual({
      path: worktreePath,
      branch: "agent/card-123",
      reused: true,
      initialStatus: " M src/example.ts\n?? src/new-file.ts",
    });

    expect(runGit).toHaveBeenNthCalledWith(1, worktreePath, [
      "branch",
      "--show-current",
    ]);

    expect(runGit).toHaveBeenNthCalledWith(2, worktreePath, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);

    expect(runGit).not.toHaveBeenCalledWith(worktreePath, [
      "reset",
      "--hard",
      "HEAD",
    ]);

    expect(runGit).not.toHaveBeenCalledWith(worktreePath, ["clean", "-fd"]);
  });

  it("rejects an existing directory that is not a Git worktree", async () => {
    const worktreeRoot = createTemporaryDirectory();
    const worktreePath = path.join(worktreeRoot, "card-123");

    fs.mkdirSync(worktreePath);

    const project = createProject(worktreeRoot);
    const gitError = new Error("fatal: not a git repository");
    const runGit = vi.fn<RunGit>().mockRejectedValue(gitError);
    const git = new GitClient(runGit);

    await expect(prepareWorktree(git, project, "card-123")).rejects.toBe(
      gitError,
    );

    expect(runGit).toHaveBeenCalledWith(worktreePath, [
      "branch",
      "--show-current",
    ]);
  });

  it("rejects a card ID that escapes the worktree root", async () => {
    const worktreeRoot = createTemporaryDirectory();
    const project = createProject(worktreeRoot);
    const runGit = vi.fn<RunGit>();
    const git = new GitClient(runGit);

    await expect(prepareWorktree(git, project, "../outside")).rejects.toThrow(
      "would escape configured worktree root",
    );

    expect(runGit).not.toHaveBeenCalled();
  });
});

describe("existing worktree lookup", () => {
  function createRebaseState(): GitRebaseState {
    return {
      active: true,
      backend: "merge",
      headName: "refs/heads/agent/card-123",
      onto: "b".repeat(40),
      originalHead: "a".repeat(40),
      currentStep: 2,
      totalSteps: 4,
    };
  }

  it("accepts a detached-HEAD worktree with a matching active prepared rebase", async () => {
    const worktreeRoot = createTemporaryDirectory();
    const worktreePath = path.join(worktreeRoot, "card-123");
    fs.mkdirSync(worktreePath);
    const rebase = createRebaseState();
    const project = createProject(worktreeRoot);
    const git = {
      isValidRepository: vi.fn().mockResolvedValue(true),
      getRebaseState: vi.fn().mockResolvedValue(rebase),
      getCurrentBranch: vi.fn().mockResolvedValue(""),
    } as unknown as GitClient;

    await expect(
      getExistingPreparedConflictWorktree(git, project, "card-123", rebase),
    ).resolves.toEqual({
      path: worktreePath,
      branch: "agent/card-123",
      rebase,
    });

    expect(git.getCurrentBranch).not.toHaveBeenCalled();
  });

  it.each([
    ["headName", { headName: "refs/heads/agent/other-card" }],
    ["onto", { onto: "c".repeat(40) }],
    ["current step", { currentStep: 3 }],
  ] as const)(
    "rejects a prepared rebase with mismatched %s metadata",
    async (_label, change) => {
      const worktreeRoot = createTemporaryDirectory();
      fs.mkdirSync(path.join(worktreeRoot, "card-123"));
      const expectedRebase = createRebaseState();
      const actualRebase = { ...expectedRebase, ...change };
      const project = createProject(worktreeRoot);
      const git = {
        isValidRepository: vi.fn().mockResolvedValue(true),
        getRebaseState: vi.fn().mockResolvedValue(actualRebase),
        getCurrentBranch: vi.fn(),
      } as unknown as GitClient;

      await expect(
        getExistingPreparedConflictWorktree(
          git,
          project,
          "card-123",
          expectedRebase,
        ),
      ).resolves.toBeNull();

      expect(git.getCurrentBranch).not.toHaveBeenCalled();
    },
  );

  it("rejects a prepared conflict when its expected worktree path is missing", async () => {
    const worktreeRoot = createTemporaryDirectory();
    const project = createProject(worktreeRoot);
    const rebase = createRebaseState();
    const git = {
      isValidRepository: vi.fn(),
      getRebaseState: vi.fn(),
      getCurrentBranch: vi.fn(),
    } as unknown as GitClient;

    await expect(
      getExistingPreparedConflictWorktree(git, project, "card-123", rebase),
    ).resolves.toBeNull();

    expect(git.isValidRepository).not.toHaveBeenCalled();
  });

  it("rejects a symbolic-link prepared worktree", async () => {
    const worktreeRoot = createTemporaryDirectory();
    const targetPath = path.join(worktreeRoot, "target");
    const worktreePath = path.join(worktreeRoot, "card-123");
    fs.mkdirSync(targetPath);
    fs.symlinkSync(targetPath, worktreePath, "dir");
    const project = createProject(worktreeRoot);
    const git = {
      isValidRepository: vi.fn(),
      getRebaseState: vi.fn(),
      getCurrentBranch: vi.fn(),
    } as unknown as GitClient;

    await expect(
      getExistingPreparedConflictWorktree(
        git,
        project,
        "card-123",
        createRebaseState(),
      ),
    ).resolves.toBeNull();

    expect(git.isValidRepository).not.toHaveBeenCalled();
  });

  it("rejects a prepared worktree that is not a valid Git repository", async () => {
    const worktreeRoot = createTemporaryDirectory();
    fs.mkdirSync(path.join(worktreeRoot, "card-123"));
    const project = createProject(worktreeRoot);
    const git = {
      isValidRepository: vi.fn().mockResolvedValue(false),
      getRebaseState: vi.fn(),
      getCurrentBranch: vi.fn(),
    } as unknown as GitClient;

    await expect(
      getExistingPreparedConflictWorktree(
        git,
        project,
        "card-123",
        createRebaseState(),
      ),
    ).resolves.toBeNull();

    expect(git.getRebaseState).not.toHaveBeenCalled();
  });

  it("requires the expected branch for an ordinary existing worktree", async () => {
    const worktreeRoot = createTemporaryDirectory();
    fs.mkdirSync(path.join(worktreeRoot, "card-123"));
    const project = createProject(worktreeRoot);
    const git = {
      getCurrentBranch: vi.fn().mockResolvedValue(""),
    } as unknown as GitClient;

    await expect(
      getExistingWorktree(git, project, "card-123"),
    ).resolves.toBeNull();
    expect(git.getCurrentBranch).toHaveBeenCalledWith(
      path.join(worktreeRoot, "card-123"),
    );
  });
});
