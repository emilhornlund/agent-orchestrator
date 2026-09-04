import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getReconciliationBlockPath,
  loadReconciliationBlock,
  removeReconciliationBlock,
  writeReconciliationBlock,
  type PersistedReconciliationBlock,
} from "../src/orchestrator/reconciliation-block-storage.js";

let temporaryRoot: string | undefined;

afterEach(() => {
  if (temporaryRoot !== undefined) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

function createRoot(): string {
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-reconciliation-block-"),
  );

  return temporaryRoot;
}

function block(projectId = "project-one"): PersistedReconciliationBlock {
  return {
    version: 1,
    projectId,
    attemptKey: "card-one:pull request",
    attempt: 3,
    operation: "GitHub pull request",
    cardId: "card-one",
    reconciliationListId: "review-list",
    failureCategory: "Git/GitHub",
    failureReason: "GitHub API unavailable",
    recoveryCondition: "card-moved-to-ready",
    notificationIdentity: "full-notification-identity",
    failureIdentity: "failure-identity",
    handlingOutcome: "blocked until the card is deliberately retried",
    sessionLogPaths: ["logs/sessions/project-one/card-one.log"],
  };
}

describe("reconciliation block storage", () => {
  it("writes and reloads a project block below the runtime root", () => {
    const root = createRoot();
    const value = block();

    writeReconciliationBlock(root, value);

    expect(loadReconciliationBlock(root, value.projectId)).toEqual({
      status: "loaded",
      block: value,
    });
    expect(getReconciliationBlockPath(root, value.projectId)).toBe(
      path.join(root, value.projectId, "reconciliation-block.json"),
    );
  });

  it("reports a missing block without creating runtime directories", () => {
    const root = createRoot();

    expect(loadReconciliationBlock(root, "project-one")).toEqual({
      status: "missing",
    });
    expect(fs.existsSync(path.join(root, "project-one"))).toBe(false);
  });

  it.each([
    ["invalid JSON", "{"],
    ["missing required value", JSON.stringify({ version: 1 })],
    [
      "unsupported operation",
      JSON.stringify({ ...block(), operation: "GitHub unknown" }),
    ],
    [
      "mismatched project",
      JSON.stringify({ ...block(), projectId: "project-two" }),
    ],
    [
      "inconsistent recovery condition",
      JSON.stringify({ ...block(), recoveryCondition: "worker-restart" }),
    ],
  ])("fails closed for %s and preserves the record", (_name, contents) => {
    const root = createRoot();
    const filePath = getReconciliationBlockPath(root, "project-one");

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, "utf8");

    const result = loadReconciliationBlock(root, "project-one");

    expect(result.status).toBe("malformed");
    expect(fs.readFileSync(filePath, "utf8")).toBe(contents);
  });

  it("refuses symbolic-link runtime paths", () => {
    const root = createRoot();
    const outside = path.join(root, "outside");
    const projectDirectory = path.join(root, "project-one");

    fs.mkdirSync(outside);
    fs.symlinkSync(outside, projectDirectory, "dir");

    expect(loadReconciliationBlock(root, "project-one").status).toBe(
      "malformed",
    );
    expect(() => writeReconciliationBlock(root, block())).toThrow(
      "symbolic-link",
    );
  });

  it("removes only the known block file", () => {
    const root = createRoot();
    const value = block();
    const projectDirectory = path.join(root, value.projectId);
    const unrelatedPath = path.join(projectDirectory, "notes.txt");

    writeReconciliationBlock(root, value);
    fs.writeFileSync(unrelatedPath, "keep", "utf8");
    removeReconciliationBlock(root, value.projectId);

    expect(loadReconciliationBlock(root, value.projectId)).toEqual({
      status: "missing",
    });
    expect(fs.readFileSync(unrelatedPath, "utf8")).toBe("keep");
  });
});
