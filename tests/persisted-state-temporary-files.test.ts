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
  getReviewMaintenanceStatePath,
  writeReviewMaintenanceState,
  type ReviewMaintenanceState,
} from "../src/orchestrator/review-maintenance-state.js";
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
  review: ReviewMaintenanceState;
  rebase: GitRebaseState;
  block: PersistedReconciliationBlock;
} {
  const taskSha = "a".repeat(40);
  const defaultSha = "b".repeat(40);

  return {
    review: {
      version: 1,
      kind: "review-maintenance",
      projectId: project.id,
      cardId: "card-one",
      taskBranch: "agent/card-one",
      defaultBranch: project.repository.defaultBranch,
      remoteTaskSha: taskSha,
      remoteDefaultSha: defaultSha,
      effectiveHeadSha: taskSha,
      setupCompleted: true,
    },
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
  reviewPath: string;
  preparedPath: string;
  blockPath: string;
} {
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-state-cleanup-"),
  );
  const project = createProject(temporaryRoot);
  const contextRoot = path.join(temporaryRoot, "context");
  const values = createStateValues(project);

  fs.mkdirSync(project.repository.path, { recursive: true });
  writeReviewMaintenanceState(project, values.review.cardId, values.review);
  writePreparedConflict(
    project,
    "card-two",
    values.review.remoteTaskSha,
    ["src/file.ts"],
    values.rebase,
  );
  writeReconciliationBlock(contextRoot, values.block);

  return {
    project,
    contextRoot,
    reviewPath: getReviewMaintenanceStatePath(project, values.review.cardId),
    preparedPath: getPreparedConflictPath(project, "card-two"),
    blockPath: getReconciliationBlockPath(contextRoot, project.id),
  };
}

describe("persisted state temporary-file cleanup", () => {
  it("retains authoritative state when no temporary files exist", () => {
    const fixture = createFixture();
    const reviewContents = fs.readFileSync(fixture.reviewPath, "utf8");
    const preparedContents = fs.readFileSync(fixture.preparedPath, "utf8");
    const blockContents = fs.readFileSync(fixture.blockPath, "utf8");

    cleanupPersistedStateTemporaryFiles([fixture.project], fixture.contextRoot);

    expect(fs.readFileSync(fixture.reviewPath, "utf8")).toBe(reviewContents);
    expect(fs.readFileSync(fixture.preparedPath, "utf8")).toBe(
      preparedContents,
    );
    expect(fs.readFileSync(fixture.blockPath, "utf8")).toBe(blockContents);
  });

  it("removes stale temporary files for every persisted state store", () => {
    const fixture = createFixture();
    const staleReviewPath = `${fixture.reviewPath}.${staleProcessId}.tmp`;
    const stalePreparedPath = `${fixture.preparedPath}.${staleProcessId}.tmp`;
    const staleBlockPath = path.join(
      path.dirname(fixture.blockPath),
      `.${RECONCILIATION_BLOCK_FILENAME}.${staleProcessId}.interrupted`,
    );

    for (const filePath of [
      staleReviewPath,
      stalePreparedPath,
      staleBlockPath,
    ]) {
      fs.writeFileSync(filePath, "stale", "utf8");
    }

    cleanupPersistedStateTemporaryFiles([fixture.project], fixture.contextRoot);

    expect(fs.existsSync(staleReviewPath)).toBe(false);
    expect(fs.existsSync(stalePreparedPath)).toBe(false);
    expect(fs.existsSync(staleBlockPath)).toBe(false);
    expect(fs.existsSync(fixture.reviewPath)).toBe(true);
    expect(fs.existsSync(fixture.preparedPath)).toBe(true);
    expect(fs.existsSync(fixture.blockPath)).toBe(true);
  });

  it("retains malformed authoritative state while removing its stale temporary file", () => {
    const fixture = createFixture();
    const staleReviewPath = `${fixture.reviewPath}.${staleProcessId}.tmp`;

    fs.writeFileSync(fixture.reviewPath, "{", "utf8");
    fs.writeFileSync(staleReviewPath, "stale", "utf8");

    cleanupPersistedStateTemporaryFiles([fixture.project], fixture.contextRoot);

    expect(fs.readFileSync(fixture.reviewPath, "utf8")).toBe("{");
    expect(fs.existsSync(staleReviewPath)).toBe(false);
  });

  it("retains active-writer files, unrelated files, and non-regular entries", () => {
    const fixture = createFixture();
    const activeReviewPath = `${fixture.reviewPath}.${process.pid}.tmp`;
    const activeBlockPath = path.join(
      path.dirname(fixture.blockPath),
      `.${RECONCILIATION_BLOCK_FILENAME}.${process.pid}.active`,
    );
    const unknownReviewPath = path.join(
      path.dirname(fixture.reviewPath),
      "notes.txt",
    );
    const nonMatchingBlockPath = path.join(
      path.dirname(fixture.blockPath),
      `.${RECONCILIATION_BLOCK_FILENAME}.${staleProcessId}`,
    );
    const directoryCandidate = `${fixture.reviewPath}.other.${staleProcessId}.tmp`;
    const symlinkCandidate = `${fixture.preparedPath}.${staleProcessId}.tmp`;
    const symlinkTarget = path.join(temporaryRoot!, "outside");

    fs.writeFileSync(activeReviewPath, "active", "utf8");
    fs.writeFileSync(activeBlockPath, "active", "utf8");
    fs.writeFileSync(unknownReviewPath, "keep", "utf8");
    fs.writeFileSync(nonMatchingBlockPath, "keep", "utf8");
    fs.mkdirSync(directoryCandidate);
    fs.writeFileSync(symlinkTarget, "outside", "utf8");
    fs.symlinkSync(symlinkTarget, symlinkCandidate);

    cleanupPersistedStateTemporaryFiles([fixture.project], fixture.contextRoot);

    for (const filePath of [
      activeReviewPath,
      activeBlockPath,
      unknownReviewPath,
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
    const staleReviewPath = `${fixture.reviewPath}.${staleProcessId}.tmp`;
    const stalePreparedPath = `${fixture.preparedPath}.${staleProcessId}.tmp`;
    const staleBlockPath = path.join(
      path.dirname(fixture.blockPath),
      `.${RECONCILIATION_BLOCK_FILENAME}.${staleProcessId}.interrupted`,
    );
    const report = vi
      .spyOn(logger, "error")
      .mockImplementation(() => undefined);
    const originalUnlink = fs.unlinkSync;

    for (const filePath of [
      staleReviewPath,
      stalePreparedPath,
      staleBlockPath,
    ]) {
      fs.writeFileSync(filePath, "stale", "utf8");
    }

    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation((filePath) => {
      if (filePath === staleReviewPath) {
        throw new Error("permission denied");
      }

      return originalUnlink(filePath);
    });

    try {
      cleanupPersistedStateTemporaryFiles(
        [fixture.project],
        fixture.contextRoot,
      );

      expect(fs.existsSync(staleReviewPath)).toBe(true);
      expect(fs.existsSync(stalePreparedPath)).toBe(false);
      expect(fs.existsSync(staleBlockPath)).toBe(false);
      expect(report).toHaveBeenCalledWith(
        expect.stringContaining(`${staleReviewPath}: permission denied`),
      );
    } finally {
      unlink.mockRestore();
      report.mockRestore();
    }
  });
});
