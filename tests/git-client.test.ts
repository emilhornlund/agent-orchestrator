import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  GitClient,
  getGitIdentityEnvironment,
  type GitIdentity,
  type RunGit,
} from "../src/git/git-client.js";
describe("GitClient", () => {
  it("fetches a branch from a remote", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const git = new GitClient(runGit);

    await git.fetch("/repo", "origin", "main");

    expect(runGit).toHaveBeenCalledWith("/repo", ["fetch", "origin", "main"]);
  });

  it("refuses rebase without dispatching any Git command", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const git = new GitClient(runGit);
    const identity: GitIdentity = {
      name: "Agent Orchestrator",
      email: "agent-orchestrator@example.com",
    };

    await expect(
      git.rebase("/worktree", "origin/main", identity),
    ).rejects.toThrow("disabled by the P1 safety guardrail");
    expect(runGit).not.toHaveBeenCalled();
  });

  it("keeps signed rebase requests behind the same no-dispatch guard", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const git = new GitClient(runGit);

    await expect(
      git.rebase("/worktree", "origin/main", {
        name: "Agent Orchestrator",
        email: "agent-orchestrator@example.com",
        signingKey: "/home/agent/.ssh/signing-key.pub",
      }),
    ).rejects.toThrow("disabled by the P1 safety guardrail");
    expect(runGit).not.toHaveBeenCalled();
  });

  it("checks whether one commit is an ancestor of another", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const git = new GitClient(runGit);

    await expect(
      git.isAncestor("/worktree", "remote-sha", "head-sha"),
    ).resolves.toBe(true);

    expect(runGit).toHaveBeenCalledWith("/worktree", [
      "merge-base",
      "--is-ancestor",
      "remote-sha",
      "head-sha",
    ]);
  });

  it("treats a failed ancestor check as not fast-forward safe", async () => {
    const runGit = vi.fn<RunGit>().mockRejectedValue(new Error("not ancestor"));
    const git = new GitClient(runGit);

    await expect(
      git.isAncestor("/worktree", "remote-sha", "head-sha"),
    ).resolves.toBe(false);
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

  it("reads staged and unstaged binary diffs", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("diff output");
    const git = new GitClient(runGit);

    await git.getDiff("/worktree");
    await git.getDiff("/worktree", true);

    expect(runGit).toHaveBeenNthCalledWith(1, "/worktree", [
      "diff",
      "--binary",
    ]);
    expect(runGit).toHaveBeenNthCalledWith(2, "/worktree", [
      "diff",
      "--cached",
      "--binary",
    ]);
  });

  it("lists untracked files with NUL-delimited Git output", async () => {
    const runGit = vi
      .fn<RunGit>()
      .mockResolvedValue("new.txt\0nested/file.txt\0");
    const git = new GitClient(runGit);

    await expect(git.getUntrackedFiles("/worktree")).resolves.toEqual([
      "new.txt",
      "nested/file.txt",
    ]);
    expect(runGit).toHaveBeenCalledWith("/worktree", [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--full-name",
      "-z",
    ]);
  });

  it("stages all changes and commits from a message file with the configured identity", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("1");
    const git = new GitClient(runGit);
    const identity: GitIdentity = {
      name: "Agent Orchestrator",
      email: "agent-orchestrator@example.com",
    };

    await git.stageAll("/worktree");
    await git.commit("/worktree", "/tmp/message-file", identity);
    await expect(
      git.getCommitCountBetween("/worktree", "before", "after"),
    ).resolves.toBe(1);

    expect(runGit).toHaveBeenNthCalledWith(1, "/worktree", ["add", "-A"]);
    expect(runGit).toHaveBeenNthCalledWith(
      2,
      "/worktree",
      ["commit", "-F", "/tmp/message-file"],
      getGitIdentityEnvironment(identity),
    );
    expect(runGit).toHaveBeenNthCalledWith(3, "/worktree", [
      "rev-list",
      "--count",
      "before..after",
    ]);
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

  it("reads an active merge rebase and conflicted paths", async () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-orchestrator-git-rebase-"),
    );
    const rebaseDirectory = path.join(temporaryDirectory, "rebase-merge");
    fs.mkdirSync(rebaseDirectory);
    fs.writeFileSync(
      path.join(rebaseDirectory, "head-name"),
      "refs/heads/agent/card-1\n",
    );
    fs.writeFileSync(path.join(rebaseDirectory, "onto"), `${"b".repeat(40)}\n`);
    fs.writeFileSync(
      path.join(rebaseDirectory, "orig-head"),
      `${"a".repeat(40)}\n`,
    );
    fs.writeFileSync(path.join(rebaseDirectory, "msgnum"), "2\n");
    fs.writeFileSync(path.join(rebaseDirectory, "end"), "4\n");
    const runGit = vi.fn<RunGit>(async (_cwd, args) => {
      if (args[0] === "rev-parse" && args[2] === "rebase-merge") {
        return rebaseDirectory;
      }

      if (args[0] === "rev-parse" && args[2] === "rebase-apply") {
        return path.join(temporaryDirectory, "rebase-apply");
      }

      if (args[0] === "diff") {
        return "src/changed.ts\nsrc/other.ts\n";
      }

      return "";
    });
    const git = new GitClient(runGit);

    try {
      await expect(git.getRebaseState(temporaryDirectory)).resolves.toEqual({
        active: true,
        backend: "merge",
        headName: "refs/heads/agent/card-1",
        onto: "b".repeat(40),
        originalHead: "a".repeat(40),
        currentStep: 2,
        totalSteps: 4,
      });
      await expect(git.getConflictedPaths(temporaryDirectory)).resolves.toEqual(
        ["src/changed.ts", "src/other.ts"],
      );
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("gets files changed from a base ref", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("src/main.cpp");
    const git = new GitClient(runGit);

    await expect(git.getChangedFiles("/worktree", "origin/main")).resolves.toBe(
      "src/main.cpp",
    );

    expect(runGit).toHaveBeenCalledWith("/worktree", [
      "diff",
      "--name-only",
      "origin/main...HEAD",
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

  it("fails closed for every force-with-lease update without dispatching Git", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const git = new GitClient(runGit);

    await expect(
      git.pushWithLease(
        "/tmp/repository",
        "origin",
        "agent/card-123",
        "remote-sha",
      ),
    ).rejects.toThrow("Force-with-lease pushes are disabled");
    expect(runGit).not.toHaveBeenCalled();
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

  it("detects an existing remote branch", async () => {
    const runGit = vi.fn().mockResolvedValue("abc123\trefs/heads/agent/card-1");

    const git = new GitClient(runGit);

    await expect(
      git.remoteBranchExists("/repo", "origin", "agent/card-1"),
    ).resolves.toBe(true);

    expect(runGit).toHaveBeenCalledWith("/repo", [
      "ls-remote",
      "--heads",
      "origin",
      "refs/heads/agent/card-1",
    ]);
  });

  it("gets the SHA of an existing remote branch", async () => {
    const runGit = vi
      .fn<RunGit>()
      .mockResolvedValue("abc123\trefs/heads/agent/card-1");
    const git = new GitClient(runGit);

    await expect(
      git.getRemoteBranchSha("/repo", "origin", "agent/card-1"),
    ).resolves.toBe("abc123");
  });

  it("returns no SHA when a remote branch is missing", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const git = new GitClient(runGit);

    await expect(
      git.getRemoteBranchSha("/repo", "origin", "agent/card-1"),
    ).resolves.toBeNull();
  });

  it("rejects malformed remote branch output", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("not-a-remote-ref");
    const git = new GitClient(runGit);

    await expect(
      git.getRemoteBranchSha("/repo", "origin", "agent/card-1"),
    ).rejects.toThrow("invalid remote branch result");
  });

  it("detects a missing remote branch", async () => {
    const runGit = vi.fn().mockResolvedValue("");
    const git = new GitClient(runGit);

    await expect(
      git.remoteBranchExists("/repo", "origin", "agent/card-1"),
    ).resolves.toBe(false);
  });

  it("deletes a remote branch", async () => {
    const runGit = vi.fn().mockResolvedValue("");
    const git = new GitClient(runGit);

    await git.deleteRemoteBranch("/repo", "origin", "agent/card-1");

    expect(runGit).toHaveBeenCalledWith("/repo", [
      "push",
      "origin",
      "--delete",
      "agent/card-1",
    ]);
  });
});
