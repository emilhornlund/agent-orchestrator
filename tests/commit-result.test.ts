import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  captureRepositorySnapshot,
  clearCommitResult,
  getCommitResultPath,
  readCommitResult,
  repositorySnapshotsEqual,
} from "../src/opencode/commit-result.js";
import type { GitClient } from "../src/git/git-client.js";

function temporaryWorktree(): string {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-commit-result-"),
  );
}

function writeResult(worktreePath: string, value: unknown): void {
  const resultPath = getCommitResultPath(worktreePath);

  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, JSON.stringify(value));
}

describe("commit result", () => {
  it("reads a valid structured multiline commit result", () => {
    const worktreePath = temporaryWorktree();

    try {
      const message =
        "feat(workflow): make commits deterministic\n\n- Validate the generated message.\n- Keep Git mutations in the orchestrator.\n\nThe workflow now has a strict handoff.";
      writeResult(worktreePath, { message });

      expect(readCommitResult(worktreePath)).toEqual({ message });
    } finally {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing", undefined],
    ["malformed JSON", "{"],
    ["blank message", { message: " \n\t" }],
    ["extra field", { message: "valid", extra: true }],
  ])("rejects %s commit result output", (_label, value) => {
    const worktreePath = temporaryWorktree();

    try {
      if (value !== undefined) {
        const resultPath = getCommitResultPath(worktreePath);

        fs.mkdirSync(path.dirname(resultPath), { recursive: true });
        fs.writeFileSync(
          resultPath,
          typeof value === "string" ? value : JSON.stringify(value),
        );
      }

      expect(() => readCommitResult(worktreePath)).toThrow();
    } finally {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it("removes a stale result artifact before generation", () => {
    const worktreePath = temporaryWorktree();

    try {
      writeResult(worktreePath, { message: "stale" });

      clearCommitResult(worktreePath);

      expect(fs.existsSync(getCommitResultPath(worktreePath))).toBe(false);
    } finally {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it("detects untracked file content mutations", async () => {
    const worktreePath = temporaryWorktree();

    try {
      fs.writeFileSync(path.join(worktreePath, "untracked.txt"), "initial\n");

      const git = {
        getStatus: vi.fn().mockResolvedValue("?? untracked.txt"),
        getDiff: vi
          .fn()
          .mockResolvedValueOnce("unstaged diff")
          .mockResolvedValueOnce("staged diff"),
        getUntrackedFiles: vi.fn().mockResolvedValue(["untracked.txt"]),
      } as unknown as GitClient;

      await expect(
        captureRepositorySnapshot(git, worktreePath),
      ).resolves.toEqual({
        status: "?? untracked.txt",
        unstagedDiff: "unstaged diff",
        stagedDiff: "staged diff",
        untrackedFiles: expect.any(String),
      });

      const before = await captureRepositorySnapshot(git, worktreePath);
      fs.writeFileSync(path.join(worktreePath, "untracked.txt"), "changed\n");
      const after = await captureRepositorySnapshot(git, worktreePath);

      expect(repositorySnapshotsEqual(before, after)).toBe(false);
      expect(git.getUntrackedFiles).toHaveBeenCalledWith(worktreePath);
    } finally {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it("captures status, repository diffs, and untracked files", async () => {
    const git = {
      getStatus: vi.fn().mockResolvedValue(" M tracked.txt"),
      getDiff: vi
        .fn()
        .mockResolvedValueOnce("unstaged diff")
        .mockResolvedValueOnce("staged diff"),
      getUntrackedFiles: vi.fn().mockResolvedValue([]),
    } as unknown as GitClient;

    await expect(captureRepositorySnapshot(git, "/worktree")).resolves.toEqual({
      status: " M tracked.txt",
      unstagedDiff: "unstaged diff",
      stagedDiff: "staged diff",
      untrackedFiles: "[]",
    });
    expect(git.getDiff).toHaveBeenNthCalledWith(1, "/worktree");
    expect(git.getDiff).toHaveBeenNthCalledWith(2, "/worktree", true);
    expect(git.getUntrackedFiles).toHaveBeenCalledWith("/worktree");
  });

  it("detects status, unstaged-diff, and staged-diff mutations", () => {
    const snapshot = {
      status: " M tracked.txt",
      unstagedDiff: "unstaged",
      stagedDiff: "staged",
      untrackedFiles: "[]",
    };

    expect(repositorySnapshotsEqual(snapshot, { ...snapshot })).toBe(true);
    expect(
      repositorySnapshotsEqual(snapshot, {
        ...snapshot,
        status: "M  tracked.txt",
      }),
    ).toBe(false);
    expect(
      repositorySnapshotsEqual(snapshot, {
        ...snapshot,
        unstagedDiff: "changed",
      }),
    ).toBe(false);
    expect(
      repositorySnapshotsEqual(snapshot, {
        ...snapshot,
        stagedDiff: "changed",
      }),
    ).toBe(false);
    expect(
      repositorySnapshotsEqual(snapshot, {
        ...snapshot,
        untrackedFiles: '[{"path":"new.txt"}]',
      }),
    ).toBe(false);
  });
});
