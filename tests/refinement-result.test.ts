import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  clearRefinementResult,
  getRefinementResultPath,
  readRefinementResult,
  refinementResultRelativePath,
} from "../src/refinement/refinement-result.js";

const temporaryDirectories: string[] = [];

function createWorktree(): string {
  const worktreePath = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-refinement-"),
  );

  temporaryDirectories.push(worktreePath);

  return worktreePath;
}

function writeResult(worktreePath: string, value: unknown): string {
  const resultPath = getRefinementResultPath(worktreePath);

  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, JSON.stringify(value));

  return resultPath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
});

describe("refinement result", () => {
  it("uses the dedicated refinement result path", () => {
    const worktreePath = "/tmp/worktree";

    expect(getRefinementResultPath(worktreePath)).toBe(
      path.join(worktreePath, refinementResultRelativePath),
    );
  });

  it("clears an existing refinement result", () => {
    const worktreePath = createWorktree();

    const resultPath = writeResult(worktreePath, {
      title: "Stale task",
      type: "feature",
      description: "Stale description",
    });

    expect(fs.existsSync(resultPath)).toBe(true);

    clearRefinementResult(worktreePath);

    expect(fs.existsSync(resultPath)).toBe(false);
  });

  it("does nothing when no refinement result exists", () => {
    const worktreePath = createWorktree();

    expect(() => clearRefinementResult(worktreePath)).not.toThrow();
  });

  it("removes a stale refinement result symbolic link without deleting its target", () => {
    const worktreePath = createWorktree();
    const targetPath = path.join(worktreePath, "stale-target.json");
    const resultPath = getRefinementResultPath(worktreePath);

    fs.writeFileSync(targetPath, "stale");

    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    fs.symlinkSync(targetPath, resultPath);

    clearRefinementResult(worktreePath);

    expect(fs.existsSync(resultPath)).toBe(false);
    expect(fs.readFileSync(targetPath, "utf8")).toBe("stale");
  });

  it("refuses to recursively remove a directory at the refinement result path", () => {
    const worktreePath = createWorktree();
    const resultPath = getRefinementResultPath(worktreePath);

    fs.mkdirSync(resultPath, { recursive: true });

    expect(() => clearRefinementResult(worktreePath)).toThrow();
    expect(fs.statSync(resultPath).isDirectory()).toBe(true);
  });

  it.each(["feature", "improvement", "bug"] as const)(
    "accepts a valid %s refinement result",
    (type) => {
      const worktreePath = createWorktree();

      writeResult(worktreePath, {
        title: "Improve task",
        type,
        description: "## Description\n\nImplementation-ready task.",
      });

      expect(readRefinementResult(worktreePath)).toEqual({
        title: "Improve task",
        type,
        description: "## Description\n\nImplementation-ready task.",
      });
    },
  );

  it("rejects a missing refinement result", () => {
    const worktreePath = createWorktree();

    expect(() => readRefinementResult(worktreePath)).toThrow(
      "Refinement result file not found",
    );
  });

  it("rejects malformed JSON", () => {
    const worktreePath = createWorktree();
    const resultPath = getRefinementResultPath(worktreePath);

    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    fs.writeFileSync(resultPath, "{");

    expect(() => readRefinementResult(worktreePath)).toThrow(
      "Invalid refinement result JSON",
    );
  });

  it("rejects an unsupported task type", () => {
    const worktreePath = createWorktree();

    writeResult(worktreePath, {
      title: "Refactor task",
      type: "refactor",
      description: "Description",
    });

    expect(() => readRefinementResult(worktreePath)).toThrow(
      "Invalid refinement result",
    );
  });

  it("rejects blank titles", () => {
    const worktreePath = createWorktree();

    writeResult(worktreePath, {
      title: "   ",
      type: "feature",
      description: "Description",
    });

    expect(() => readRefinementResult(worktreePath)).toThrow(
      "Refinement title must not be blank",
    );
  });

  it("rejects blank descriptions", () => {
    const worktreePath = createWorktree();

    writeResult(worktreePath, {
      title: "Task",
      type: "feature",
      description: "   ",
    });

    expect(() => readRefinementResult(worktreePath)).toThrow(
      "Refinement description must not be blank",
    );
  });

  it("rejects unexpected fields", () => {
    const worktreePath = createWorktree();

    writeResult(worktreePath, {
      title: "Task",
      type: "feature",
      description: "Description",
      labelId: "arbitrary-label",
    });

    expect(() => readRefinementResult(worktreePath)).toThrow(
      "Invalid refinement result",
    );
  });

  it("rejects symbolic links", () => {
    const worktreePath = createWorktree();
    const targetPath = path.join(worktreePath, "outside.json");
    const resultPath = getRefinementResultPath(worktreePath);

    fs.writeFileSync(
      targetPath,
      JSON.stringify({
        title: "Task",
        type: "feature",
        description: "Description",
      }),
    );

    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    fs.symlinkSync(targetPath, resultPath);

    expect(() => readRefinementResult(worktreePath)).toThrow(
      "Refinement result must not be a symbolic link",
    );
  });
});
