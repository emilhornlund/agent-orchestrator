import { describe, expect, it, vi } from "vitest";

import type { GitClient } from "../src/git/git-client.js";
import { hasCommittedImplementation } from "../src/git/detect-committed-implementation.js";

describe("hasCommittedImplementation", () => {
  it("recognizes clean tracked changes as committed implementation work", async () => {
    const git = {
      getStatus: vi.fn().mockResolvedValue(""),
      getChangedFiles: vi.fn().mockResolvedValue("src/example.ts"),
    } as unknown as GitClient;

    await expect(
      hasCommittedImplementation(git, "/worktree", "origin/main"),
    ).resolves.toBe(true);

    expect(git.getStatus).toHaveBeenCalledWith("/worktree");
    expect(git.getChangedFiles).toHaveBeenCalledWith(
      "/worktree",
      "origin/main",
    );
  });

  it("does not treat a clean branch at its base as implementation work", async () => {
    const git = {
      getStatus: vi.fn().mockResolvedValue(""),
      getChangedFiles: vi.fn().mockResolvedValue(""),
    } as unknown as GitClient;

    await expect(
      hasCommittedImplementation(git, "/worktree", "origin/main"),
    ).resolves.toBe(false);
  });

  it("does not treat uncommitted changes as a completed commit", async () => {
    const git = {
      getStatus: vi.fn().mockResolvedValue(" M src/example.ts"),
      getChangedFiles: vi.fn(),
    } as unknown as GitClient;

    await expect(
      hasCommittedImplementation(git, "/worktree", "origin/main"),
    ).resolves.toBe(false);

    expect(git.getChangedFiles).not.toHaveBeenCalled();
  });

  it("can use the status already collected while preparing a reused worktree", async () => {
    const git = {
      getStatus: vi.fn(),
      getChangedFiles: vi.fn().mockResolvedValue("src/example.ts"),
    } as unknown as GitClient;

    await expect(
      hasCommittedImplementation(git, "/worktree", "origin/main", ""),
    ).resolves.toBe(true);

    expect(git.getStatus).not.toHaveBeenCalled();
  });
});
