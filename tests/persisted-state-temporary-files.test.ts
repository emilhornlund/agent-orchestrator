import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import type { GitRebaseState } from "../src/git/git-client.js";
import {
  getPreparedConflictPath,
  writePreparedConflict,
} from "../src/orchestrator/prepared-conflict-state.js";
import {
  RECONCILIATION_BLOCK_FILENAME,
  getReconciliationBlockPath,
  writeReconciliationBlock,
  type PersistedReconciliationBlock,
} from "../src/orchestrator/reconciliation-block-storage.js";
import {
  getRejectedCommitStatePath,
  getTrustedCommitStatePath,
  writeRejectedCommitState,
  writeTrustedCommitState,
} from "../src/orchestrator/trusted-commit-state.js";
import { cleanupPersistedStateTemporaryFiles } from "../src/orchestrator/persisted-state-temporary-files.js";
import { logger } from "../src/logging/logger.js";

const staleProcessId = "99999999";
let temporaryRoot: string | undefined;

afterEach(() => {
  if (temporaryRoot !== undefined) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

function createProject(root: string): ProjectConfig {
  return {
    id: "project-one",
    autoMerge: false,
    repository: {
      path: path.join(root, "repository"),
      github: "owner/repository",
      defaultBranch: "main",
      worktreeRoot: path.join(root, "worktrees"),
      gitIdentity: {
        name: "Agent Orchestrator",
        email: "agent@example.com",
      },
    },
    trello: {
      boardId: "board",
      backlogListId: "backlog",
      readyListId: "ready",
      workingListId: "working",
      reviewListId: "review",
      failedListId: "failed",
      doneListId: "done",
      refinementLabelId: "refinement",
      featureLabelId: "feature",
      improvementLabelId: "improvement",
      bugLabelId: "bug",
    },
    opencode: {
      refinement: { model: "model", variant: "variant" },
      implementation: { model: "model", variant: "variant" },
      review: { model: "model", variant: "variant" },
      remediation: { model: "model", variant: "variant", maxPasses: 1 },
      commit: { model: "model", variant: "variant" },
      timeoutMinutes: 5,
    },
  };
}

function createStateValues(project: ProjectConfig): {
  rebase: GitRebaseState;
  block: PersistedReconciliationBlock;
} {
  const taskSha = "a".repeat(40);
  const defaultSha = "b".repeat(40);

  return {
    rebase: {
      active: true,
      backend: "merge",
      headName: "agent/card-two",
      onto: defaultSha,
      originalHead: taskSha,
    },
    block: {
      version: 1,
      projectId: project.id,
      attemptKey: "card-one:pull request",
      attempt: 3,
      operation: "GitHub pull request",
      cardId: "card-one",
      reconciliationListId: "review",
      failureCategory: "Git/GitHub",
      failureReason: "GitHub unavailable",
      recoveryCondition: "card-moved-to-ready",
      notificationIdentity: "notification",
      failureIdentity: "failure",
    },
  };
}

function createFixture(): {
  project: ProjectConfig;
  contextRoot: string;
  preparedPath: string;
  blockPath: string;
  trustedPath: string;
  rejectedPath: string;
} {
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-state-cleanup-"),
  );
  const project = createProject(temporaryRoot);
  const contextRoot = path.join(temporaryRoot, "context");
  const values = createStateValues(project);

  fs.mkdirSync(project.repository.path, { recursive: true });
  writePreparedConflict(project, "card-two", ["src/file.ts"], values.rebase, {
    origin: "initial-publication",
    trustedTaskCommitSha: values.rebase.originalHead,
    rebaseTargetSha: values.rebase.onto,
  });
  writeTrustedCommitState(project, "card-one", {
    version: 1,
    kind: "trusted-commit",
    projectId: project.id,
    cardId: "card-one",
    taskBranch: "agent/card-one",
    defaultBranch: project.repository.defaultBranch,
    commitSha: "a".repeat(40),
  });
  writeRejectedCommitState(project, "card-one", {
    version: 1,
    kind: "rejected-commit",
    projectId: project.id,
    cardId: "card-one",
    taskBranch: "agent/card-one",
    defaultBranch: project.repository.defaultBranch,
    commitSha: "c".repeat(40),
  });
  writeReconciliationBlock(contextRoot, values.block);

  return {
    project,
    contextRoot,
    preparedPath: getPreparedConflictPath(project, "card-two"),
    blockPath: getReconciliationBlockPath(contextRoot, project.id),
    trustedPath: getTrustedCommitStatePath(project, "card-one"),
    rejectedPath: getRejectedCommitStatePath(project, "card-one"),
  };
}

describe("persisted state temporary-file cleanup", () => {
  it("retains authoritative state when no temporary files exist", () => {
    const fixture = createFixture();
    const preparedContents = fs.readFileSync(fixture.preparedPath, "utf8");
    const blockContents = fs.readFileSync(fixture.blockPath, "utf8");
    const trustedContents = fs.readFileSync(fixture.trustedPath, "utf8");
    const rejectedContents = fs.readFileSync(fixture.rejectedPath, "utf8");

    cleanupPersistedStateTemporaryFiles([fixture.project], fixture.contextRoot);

    expect(fs.readFileSync(fixture.preparedPath, "utf8")).toBe(
      preparedContents,
    );
    expect(fs.readFileSync(fixture.blockPath, "utf8")).toBe(blockContents);
    expect(fs.readFileSync(fixture.trustedPath, "utf8")).toBe(trustedContents);
    expect(fs.readFileSync(fixture.rejectedPath, "utf8")).toBe(
      rejectedContents,
    );
  });

  it("removes stale temporary files for every persisted state store", () => {
    const fixture = createFixture();
    const stalePreparedPath = `${fixture.preparedPath}.${staleProcessId}.tmp`;
    const staleTrustedPath = `${fixture.trustedPath}.${staleProcessId}.tmp`;
    const staleRejectedPath = `${fixture.rejectedPath}.${staleProcessId}.tmp`;
    const staleBlockPath = path.join(
      path.dirname(fixture.blockPath),
      `.${RECONCILIATION_BLOCK_FILENAME}.${staleProcessId}.interrupted`,
    );

    for (const filePath of [
      stalePreparedPath,
      staleTrustedPath,
      staleRejectedPath,
      staleBlockPath,
    ]) {
      fs.writeFileSync(filePath, "stale", "utf8");
    }

    cleanupPersistedStateTemporaryFiles([fixture.project], fixture.contextRoot);

    expect(fs.existsSync(stalePreparedPath)).toBe(false);
    expect(fs.existsSync(staleTrustedPath)).toBe(false);
    expect(fs.existsSync(staleRejectedPath)).toBe(false);
    expect(fs.existsSync(staleBlockPath)).toBe(false);
    expect(fs.existsSync(fixture.preparedPath)).toBe(true);
    expect(fs.existsSync(fixture.blockPath)).toBe(true);
    expect(fs.existsSync(fixture.trustedPath)).toBe(true);
    expect(fs.existsSync(fixture.rejectedPath)).toBe(true);
  });

  it("retains malformed authoritative state while removing its stale temporary file", () => {
    const fixture = createFixture();
    const stalePreparedPath = `${fixture.preparedPath}.${staleProcessId}.tmp`;

    fs.writeFileSync(fixture.preparedPath, "{", "utf8");
    fs.writeFileSync(stalePreparedPath, "stale", "utf8");

    cleanupPersistedStateTemporaryFiles([fixture.project], fixture.contextRoot);

    expect(fs.readFileSync(fixture.preparedPath, "utf8")).toBe("{");
    expect(fs.existsSync(stalePreparedPath)).toBe(false);
  });

  it("retains active-writer files, unrelated files, and non-regular entries", () => {
    const fixture = createFixture();
    const activePreparedPath = `${fixture.preparedPath}.${process.pid}.tmp`;
    const activeBlockPath = path.join(
      path.dirname(fixture.blockPath),
      `.${RECONCILIATION_BLOCK_FILENAME}.${process.pid}.active`,
    );
    const unknownPreparedPath = path.join(
      path.dirname(fixture.preparedPath),
      "notes.txt",
    );
    const nonMatchingBlockPath = path.join(
      path.dirname(fixture.blockPath),
      `.${RECONCILIATION_BLOCK_FILENAME}.${staleProcessId}`,
    );
    const directoryCandidate = path.join(
      path.dirname(fixture.preparedPath),
      `other.json.${staleProcessId}.tmp`,
    );
    const symlinkCandidate = `${fixture.preparedPath}.${staleProcessId}.tmp`;
    const symlinkTarget = path.join(temporaryRoot!, "outside");

    fs.writeFileSync(activePreparedPath, "active", "utf8");
    fs.writeFileSync(activeBlockPath, "active", "utf8");
    fs.writeFileSync(unknownPreparedPath, "keep", "utf8");
    fs.writeFileSync(nonMatchingBlockPath, "keep", "utf8");
    fs.mkdirSync(directoryCandidate);
    fs.writeFileSync(symlinkTarget, "outside", "utf8");
    fs.symlinkSync(symlinkTarget, symlinkCandidate);

    cleanupPersistedStateTemporaryFiles([fixture.project], fixture.contextRoot);

    for (const filePath of [
      activePreparedPath,
      activeBlockPath,
      unknownPreparedPath,
      nonMatchingBlockPath,
      directoryCandidate,
      symlinkCandidate,
    ]) {
      expect(fs.lstatSync(filePath)).toBeDefined();
    }
    expect(fs.readFileSync(symlinkTarget, "utf8")).toBe("outside");
  });

  it("treats missing state directories as harmless", () => {
    temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-orchestrator-state-cleanup-"),
    );
    const project = createProject(temporaryRoot);

    expect(() =>
      cleanupPersistedStateTemporaryFiles(
        [project],
        path.join(temporaryRoot!, "missing-context"),
      ),
    ).not.toThrow();
  });

  it("reports removal failures and continues with other state stores", () => {
    const fixture = createFixture();
    const stalePreparedPath = `${fixture.preparedPath}.${staleProcessId}.tmp`;
    const staleTrustedPath = `${fixture.trustedPath}.${staleProcessId}.tmp`;
    const staleRejectedPath = `${fixture.rejectedPath}.${staleProcessId}.tmp`;
    const staleBlockPath = path.join(
      path.dirname(fixture.blockPath),
      `.${RECONCILIATION_BLOCK_FILENAME}.${staleProcessId}.interrupted`,
    );
    const report = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const originalUnlink = fs.unlinkSync;

    for (const filePath of [
      stalePreparedPath,
      staleTrustedPath,
      staleRejectedPath,
      staleBlockPath,
    ]) {
      fs.writeFileSync(filePath, "stale", "utf8");
    }

    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation((filePath) => {
      if (filePath === stalePreparedPath) {
        throw new Error("permission denied");
      }

      return originalUnlink(filePath);
    });

    try {
      cleanupPersistedStateTemporaryFiles(
        [fixture.project],
        fixture.contextRoot,
      );

      expect(fs.existsSync(stalePreparedPath)).toBe(true);
      expect(fs.existsSync(staleTrustedPath)).toBe(false);
      expect(fs.existsSync(staleRejectedPath)).toBe(false);
      expect(fs.existsSync(staleBlockPath)).toBe(false);
      expect(report).toHaveBeenCalledWith(
        expect.stringContaining(`${stalePreparedPath}: permission denied`),
      );
    } finally {
      unlink.mockRestore();
      report.mockRestore();
    }
  });
});
