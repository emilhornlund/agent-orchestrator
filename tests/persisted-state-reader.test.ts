import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import {
  getPreparedConflictPath,
  readPreparedConflict,
  writePreparedConflict,
} from "../src/orchestrator/prepared-conflict-state.js";
import {
  getReconciliationBlockPath,
  loadReconciliationBlock,
  writeReconciliationBlock,
} from "../src/orchestrator/reconciliation-block-storage.js";
import {
  getReviewMaintenanceStatePath,
  readReviewMaintenanceState,
  writeReviewMaintenanceState,
} from "../src/orchestrator/review-maintenance-state.js";
import { MAX_PERSISTED_STATE_FILE_BYTES } from "../src/orchestrator/persisted-state-reader.js";

let temporaryRoot: string | undefined;

afterEach(() => {
  if (temporaryRoot !== undefined) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

function createProject(worktreeRoot: string): ProjectConfig {
  return {
    id: "project-one",
    autoMerge: false,
    repository: {
      path: path.join(worktreeRoot, "repository"),
      github: "owner/repository",
      defaultBranch: "main",
      worktreeRoot,
      gitIdentity: { name: "Agent Orchestrator", email: "agent@example.com" },
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

function createFixture() {
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-persisted-state-reader-"),
  );
  const project = createProject(temporaryRoot);
  const contextRoot = path.join(temporaryRoot, "context");
  const taskSha = "a".repeat(40);
  const defaultSha = "b".repeat(40);
  const reviewPath = getReviewMaintenanceStatePath(project, "card-one");
  const preparedPath = getPreparedConflictPath(project, "card-two");
  const blockPath = getReconciliationBlockPath(contextRoot, project.id);

  writeReviewMaintenanceState(project, "card-one", {
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
  });
  writePreparedConflict(project, "card-two", taskSha, ["src/file.ts"], {
    active: true,
    backend: "merge",
    headName: "agent/card-two",
    onto: defaultSha,
    originalHead: taskSha,
  });
  writeReconciliationBlock(contextRoot, {
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
  });

  return { project, contextRoot, reviewPath, preparedPath, blockPath };
}

describe("persisted state size protection", () => {
  it("loads valid reconciliation, prepared-conflict, and review-maintenance state", () => {
    const fixture = createFixture();

    expect(
      loadReconciliationBlock(fixture.contextRoot, fixture.project.id).status,
    ).toBe("loaded");
    expect(readPreparedConflict(fixture.project, "card-two")).toMatchObject({
      cardId: "card-two",
    });
    expect(
      readReviewMaintenanceState(fixture.project, "card-one"),
    ).toMatchObject({ cardId: "card-one" });
  });

  it("preserves ordinary malformed-state handling for every store", () => {
    const fixture = createFixture();

    for (const filePath of [
      fixture.reviewPath,
      fixture.preparedPath,
      fixture.blockPath,
    ]) {
      fs.writeFileSync(filePath, "{", "utf8");
    }

    expect(
      loadReconciliationBlock(fixture.contextRoot, fixture.project.id),
    ).toMatchObject({ status: "malformed" });
    expect(() => readPreparedConflict(fixture.project, "card-two")).toThrow(
      "not valid JSON",
    );
    expect(() =>
      readReviewMaintenanceState(fixture.project, "card-one"),
    ).toThrow("not valid JSON");
  });

  it("rejects oversized state before reading content and preserves each file", () => {
    const fixture = createFixture();
    const oversized = `oversized-state-content-${"x".repeat(MAX_PERSISTED_STATE_FILE_BYTES)}`;

    for (const filePath of [
      fixture.reviewPath,
      fixture.preparedPath,
      fixture.blockPath,
    ]) {
      fs.writeFileSync(filePath, oversized, "utf8");
    }

    const readFile = vi.spyOn(fs, "readFileSync");

    try {
      const reconciliationResult = loadReconciliationBlock(
        fixture.contextRoot,
        fixture.project.id,
      );
      expect(reconciliationResult).toMatchObject({ status: "malformed" });
      if (reconciliationResult.status === "malformed") {
        expect(reconciliationResult.error.message).toContain(
          `exceeds the ${MAX_PERSISTED_STATE_FILE_BYTES}-byte limit`,
        );
        expect(reconciliationResult.error.message).toContain(fixture.blockPath);
      }

      expect(() => readPreparedConflict(fixture.project, "card-two")).toThrow(
        `exceeds the ${MAX_PERSISTED_STATE_FILE_BYTES}-byte limit: ${fixture.preparedPath}`,
      );
      expect(() =>
        readReviewMaintenanceState(fixture.project, "card-one"),
      ).toThrow(
        `exceeds the ${MAX_PERSISTED_STATE_FILE_BYTES}-byte limit: ${fixture.reviewPath}`,
      );
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      readFile.mockRestore();
    }

    for (const filePath of [
      fixture.reviewPath,
      fixture.preparedPath,
      fixture.blockPath,
    ]) {
      expect(fs.readFileSync(filePath, "utf8")).toBe(oversized);
    }
  });
});
