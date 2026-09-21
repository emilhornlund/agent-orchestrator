import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import {
  getRejectedCommitStatePath,
  getTrustedCommitStatePath,
  readRejectedCommitState,
  readTrustedCommitState,
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
});
