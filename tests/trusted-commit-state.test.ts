import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import {
  getRejectedCommitStatePath,
  getTrustedCommitStatePath,
  readRejectedCommitState,
  readTrustedCommitState,
  recoverPendingTaskCommit,
  readPendingCommitState,
  writePendingCommitState,
  writeRejectedCommitState,
  writeTrustedCommitState,
} from "../src/orchestrator/trusted-commit-state.js";

function createProject(worktreeRoot: string): ProjectConfig {
  return {
    id: "project-1",
    repository: {
      path: "/repository",
      github: "owner/repository",
      worktreeRoot,
      defaultBranch: "main",
    },
  } as ProjectConfig;
}

describe("trusted commit state", () => {
  it("persists and validates the orchestrator-created commit identity", () => {
    const worktreeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-orchestrator-trusted-commit-"),
    );
    const project = createProject(worktreeRoot);

    try {
      writeTrustedCommitState(project, "card-1", {
        version: 1,
        kind: "trusted-commit",
        projectId: project.id,
        cardId: "card-1",
        taskBranch: "agent/card-1",
        defaultBranch: project.repository.defaultBranch,
        commitSha: "orchestrator-commit",
      });

      expect(readTrustedCommitState(project, "card-1")).toEqual({
        version: 1,
        kind: "trusted-commit",
        projectId: project.id,
        cardId: "card-1",
        taskBranch: "agent/card-1",
        defaultBranch: project.repository.defaultBranch,
        commitSha: "orchestrator-commit",
      });
      expect(fs.existsSync(getTrustedCommitStatePath(project, "card-1"))).toBe(
        true,
      );
    } finally {
      fs.rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  it("rejects state for a different project, card, or default branch", () => {
    const worktreeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-orchestrator-trusted-commit-"),
    );
    const project = createProject(worktreeRoot);

    try {
      writeTrustedCommitState(project, "card-1", {
        version: 1,
        kind: "trusted-commit",
        projectId: project.id,
        cardId: "card-1",
        taskBranch: "agent/card-1",
        defaultBranch: project.repository.defaultBranch,
        commitSha: "trusted-commit",
      });

      const statePath = getTrustedCommitStatePath(project, "card-1");
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          version: 1,
          kind: "trusted-commit",
          projectId: "different-project",
          cardId: "card-1",
          taskBranch: "agent/card-1",
          defaultBranch: project.repository.defaultBranch,
          commitSha: "trusted-commit",
        }),
      );

      expect(() => readTrustedCommitState(project, "card-1")).toThrow(
        "Trusted commit state does not match project project-1",
      );
      expect(() =>
        readTrustedCommitState(project, "different-card"),
      ).not.toThrow();

      writeTrustedCommitState(project, "card-1", {
        version: 1,
        kind: "trusted-commit",
        projectId: project.id,
        cardId: "card-1",
        taskBranch: "agent/card-1",
        defaultBranch: project.repository.defaultBranch,
        commitSha: "trusted-commit",
      });

      expect(() =>
        readTrustedCommitState(
          {
            ...project,
            repository: { ...project.repository, defaultBranch: "trunk" },
          },
          "card-1",
        ),
      ).toThrow("Trusted commit state does not match project project-1");
    } finally {
      fs.rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  it("persists a rejected commit marker separately from trusted state", () => {
    const worktreeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-orchestrator-rejected-commit-"),
    );
    const project = createProject(worktreeRoot);

    try {
      writeRejectedCommitState(project, "card-1", {
        version: 1,
        kind: "rejected-commit",
        projectId: project.id,
        cardId: "card-1",
        taskBranch: "agent/card-1",
        defaultBranch: project.repository.defaultBranch,
        commitSha: "rejected-commit",
      });

      expect(readRejectedCommitState(project, "card-1")).toEqual({
        version: 1,
        kind: "rejected-commit",
        projectId: project.id,
        cardId: "card-1",
        taskBranch: "agent/card-1",
        defaultBranch: project.repository.defaultBranch,
        commitSha: "rejected-commit",
      });
      expect(fs.existsSync(getRejectedCommitStatePath(project, "card-1"))).toBe(
        true,
      );
      expect(readTrustedCommitState(project, "card-1")).toBeNull();
    } finally {
      fs.rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });
  it("adopts a clean exact child of a pending task commit and refuses ambiguous state", async () => {
    const worktreeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-orchestrator-pending-commit-"),
    );
    const project = createProject(worktreeRoot);
    const parent = "a".repeat(40);
    const head = "b".repeat(40);
    const pending = {
      version: 1 as const,
      kind: "pending-commit" as const,
      projectId: project.id,
      cardId: "card-1",
      taskBranch: "agent/card-1",
      defaultBranch: "main",
      parentSha: parent,
    };
    const git = {
      getCurrentBranch: vi.fn().mockResolvedValue("agent/card-1"),
      getHeadSha: vi.fn().mockResolvedValue(head),
      getCommitParentSha: vi.fn().mockResolvedValue(parent),
      getStatus: vi.fn().mockResolvedValue(""),
    };
    try {
      writePendingCommitState(project, "card-1", pending);
      await expect(
        recoverPendingTaskCommit({
          project,
          cardId: "card-1",
          worktreePath: "/owned-worktree",
          git: git as never,
          remoteHeadSha: head,
          pullRequestExists: false,
        }),
      ).rejects.toThrow("ambiguous Git state");
      expect(readPendingCommitState(project, "card-1")).not.toBeNull();

      git.getCommitParentSha.mockResolvedValueOnce("c".repeat(40));
      await expect(
        recoverPendingTaskCommit({
          project,
          cardId: "card-1",
          worktreePath: "/owned-worktree",
          git: git as never,
          remoteHeadSha: null,
          pullRequestExists: false,
        }),
      ).rejects.toThrow("ambiguous Git state");
      expect(readTrustedCommitState(project, "card-1")).toBeNull();

      const adopted = await recoverPendingTaskCommit({
        project,
        cardId: "card-1",
        worktreePath: "/owned-worktree",
        git: git as never,
        remoteHeadSha: null,
        pullRequestExists: false,
      });
      expect(adopted?.commitSha).toBe(head);
      expect(readPendingCommitState(project, "card-1")).toBeNull();
      expect(readTrustedCommitState(project, "card-1")?.commitSha).toBe(head);
    } finally {
      fs.rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });
});
