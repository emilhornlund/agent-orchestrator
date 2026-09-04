import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import {
  GitClient,
  type GitIdentity,
  type RunGit,
} from "../src/git/git-client.js";
import { GitHubCredentialProvider } from "../src/github/github-credential-provider.js";

function project(
  githubApp?: ProjectConfig["repository"]["githubApp"],
): ProjectConfig {
  return {
    id: "project-a",
    repository: {
      github: "owner/repository",
      githubApp,
    },
  } as ProjectConfig;
}

describe("GitClient", () => {
  it("fetches a branch from a remote", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const git = new GitClient(runGit);

    await git.fetch("/repo", "origin", "main");

    expect(runGit).toHaveBeenCalledWith("/repo", ["fetch", "origin", "main"]);
  });

  it("rebases a branch onto a base ref", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const git = new GitClient(runGit);
    const identity: GitIdentity = {
      name: "Agent Orchestrator",
      email: "agent-orchestrator@example.com",
    };

    await git.rebase("/worktree", "origin/main", identity);

    expect(runGit).toHaveBeenCalledWith(
      "/worktree",
      ["rebase", "origin/main"],
      {
        GIT_AUTHOR_NAME: "Agent Orchestrator",
        GIT_AUTHOR_EMAIL: "agent-orchestrator@example.com",
        GIT_COMMITTER_NAME: "Agent Orchestrator",
        GIT_COMMITTER_EMAIL: "agent-orchestrator@example.com",
      },
    );
  });

  it("passes configured signing settings when rebasing", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const git = new GitClient(runGit);

    await git.rebase("/worktree", "origin/main", {
      name: "Agent Orchestrator",
      email: "agent-orchestrator@example.com",
      signingKey: "/home/agent/.ssh/signing-key.pub",
    });

    expect(runGit).toHaveBeenCalledWith(
      "/worktree",
      ["rebase", "origin/main"],
      expect.objectContaining({
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_KEY_0: "gpg.format",
        GIT_CONFIG_VALUE_0: "ssh",
        GIT_CONFIG_KEY_1: "user.signingKey",
        GIT_CONFIG_VALUE_1: "/home/agent/.ssh/signing-key.pub",
        GIT_CONFIG_KEY_2: "commit.gpgSign",
        GIT_CONFIG_VALUE_2: "true",
      }),
    );
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

  it("updates an owned task branch with an exact force-with-lease", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const git = new GitClient(runGit);

    await git.pushWithLease(
      "/tmp/repository",
      "origin",
      "agent/card-123",
      "remote-sha",
    );

    expect(runGit).toHaveBeenCalledWith("/tmp/repository", [
      "push",
      "--force-with-lease=refs/heads/agent/card-123:remote-sha",
      "origin",
      "agent/card-123",
    ]);
    expect(runGit.mock.calls[0]?.[1]).not.toContain("--force");
  });

  it("propagates a rejected lease without attempting another update", async () => {
    const runGit = vi
      .fn<RunGit>()
      .mockRejectedValue(new Error("stale info: remote branch changed"));
    const git = new GitClient(runGit);

    await expect(
      git.pushWithLease(
        "/tmp/repository",
        "origin",
        "agent/card-123",
        "authoritative-sha",
      ),
    ).rejects.toThrow("stale info: remote branch changed");

    expect(runGit).toHaveBeenCalledTimes(1);
    expect(runGit.mock.calls[0]?.[1]).toEqual([
      "push",
      "--force-with-lease=refs/heads/agent/card-123:authoritative-sha",
      "origin",
      "agent/card-123",
    ]);
  });

  it.each(["main", "feature/other", "agent/", "agent/card/child"])(
    "rejects a non-owned branch %s before invoking Git",
    async (branch) => {
      const runGit = vi.fn<RunGit>().mockResolvedValue("");
      const git = new GitClient(runGit);

      await expect(
        git.pushWithLease("/tmp/repository", "origin", branch, "remote-sha"),
      ).rejects.toThrow("expected an agent/<card-id> branch");

      expect(runGit).not.toHaveBeenCalled();
    },
  );

  it.each(["", " "])(
    "rejects a missing expected remote SHA (%j) before invoking Git",
    async (expectedRemoteSha) => {
      const runGit = vi.fn<RunGit>().mockResolvedValue("");
      const git = new GitClient(runGit);

      await expect(
        git.pushWithLease(
          "/tmp/repository",
          "origin",
          "agent/card-123",
          expectedRemoteSha,
        ),
      ).rejects.toThrow("an authoritative current remote SHA is required");

      expect(runGit).not.toHaveBeenCalled();
    },
  );

  it("uses GitHub App askpass authentication for a lease update", async () => {
    const token = "installation-token";
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const credentials = new GitHubCredentialProvider({
      authenticator: {
        getInstallationToken: vi.fn().mockResolvedValue(token),
      },
    });
    const git = new GitClient(runGit, credentials);
    const configuredProject = project({
      appId: "app-a",
      installationId: "installation-a",
      privateKeyPath: "/secrets/app.pem",
    });

    await git.pushWithLease(
      "/tmp/repository",
      "origin",
      "agent/card-123",
      "remote-sha",
      configuredProject,
    );

    expect(runGit).toHaveBeenCalledWith(
      "/tmp/repository",
      [
        "-c",
        "credential.helper=",
        "push",
        "--force-with-lease=refs/heads/agent/card-123:remote-sha",
        "origin",
        "agent/card-123",
      ],
      expect.objectContaining({
        GH_TOKEN: token,
        GITHUB_TOKEN: token,
        GIT_ASKPASS: expect.any(String),
        GIT_TERMINAL_PROMPT: "0",
      }),
    );
    expect(runGit.mock.calls[0]?.[1]).not.toContain(token);
  });

  it("preserves ambient or PAT authentication for a lease update", async () => {
    vi.stubEnv("GH_TOKEN", "ambient-pat");

    try {
      const runGit = vi.fn<RunGit>().mockResolvedValue("");
      const git = new GitClient(runGit);

      await git.pushWithLease(
        "/tmp/repository",
        "origin",
        "agent/card-123",
        "remote-sha",
        project(),
      );

      expect(runGit).toHaveBeenCalledWith("/tmp/repository", [
        "push",
        "--force-with-lease=refs/heads/agent/card-123:remote-sha",
        "origin",
        "agent/card-123",
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
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
