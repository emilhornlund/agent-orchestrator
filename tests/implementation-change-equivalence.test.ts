import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  haveEquivalentImplementationChanges,
  isCompletePullRequestCommitRange,
} from "../src/git/implementation-change-equivalence.js";

describe("haveEquivalentImplementationChanges", () => {
  const original = [
    "diff --git a/src/task.ts b/src/task.ts",
    "index 1111111..2222222 100644",
    "--- a/src/task.ts",
    "+++ b/src/task.ts",
    "@@ -12,2 +12,3 @@",
    " const anchor = true;",
    "-const status = 'old';",
    "+const status = 'recovered';",
    "+const ready = true;",
    " const trailing = true;",
    "",
  ].join("\n");

  it("accepts patch-equivalent changes with rebased hunk positions and new commit identities", () => {
    const rebasedOrSquashed = original
      .replace("1111111..2222222", "abcdef0..1234567")
      .replace("@@ -12,2 +12,3 @@", "@@ -104,2 +104,3 @@");
    expect(
      haveEquivalentImplementationChanges(original, rebasedOrSquashed),
    ).toBe(true);
  });

  it("rejects identical changed lines at different surrounding locations", () => {
    const misplaced = original
      .replace(" const anchor = true;", " const unrelatedAnchor = true;")
      .replace(" const trailing = true;", " const unrelatedTrailing = true;");
    expect(haveEquivalentImplementationChanges(original, misplaced)).toBe(
      false,
    );
  });

  it("rejects changed, absent, or ambiguous patch evidence", () => {
    expect(
      haveEquivalentImplementationChanges(
        original,
        original.replace("recovered", "different"),
      ),
    ).toBe(false);
    expect(haveEquivalentImplementationChanges(original, "")).toBe(false);
    expect(
      haveEquivalentImplementationChanges(
        original,
        original.replace("index 1111111..2222222 100644", "GIT binary patch"),
      ),
    ).toBe(false);
  });

  it("detects an unrelated earlier commit in a real multi-commit PR history", () => {
    const repository = fs.mkdtempSync(
      path.join(os.tmpdir(), "implementation-range-history-"),
    );
    const git = (args: string[]) =>
      execFileSync("git", ["-C", repository, ...args], {
        encoding: "utf8",
      }).trim();
    try {
      execFileSync("git", ["init", "--quiet", repository]);
      git(["config", "user.name", "Recovery Test"]);
      git(["config", "user.email", "recovery@example.test"]);
      fs.writeFileSync(path.join(repository, "implementation.txt"), "before\n");
      fs.writeFileSync(path.join(repository, "base.txt"), "base\n");
      git(["add", "."]);
      git(["commit", "--quiet", "-m", "base"]);
      const base = git(["rev-parse", "HEAD"]);

      git(["checkout", "--quiet", "-b", "original-implementation"]);
      fs.writeFileSync(path.join(repository, "implementation.txt"), "after\n");
      git(["add", "implementation.txt"]);
      git(["commit", "--quiet", "-m", "task implementation"]);
      const implementation = git(["rev-parse", "HEAD"]);
      const originalChange = git([
        "diff",
        "--no-ext-diff",
        "--no-renames",
        "--no-color",
        "--unified=3",
        `${implementation}^`,
        implementation,
      ]);

      git(["checkout", "--quiet", "-b", "recovery", base]);
      fs.writeFileSync(path.join(repository, "unrelated.txt"), "unrelated\n");
      git(["add", "unrelated.txt"]);
      git(["commit", "--quiet", "-m", "unrelated earlier PR change"]);
      fs.writeFileSync(path.join(repository, "implementation.txt"), "after\n");
      git(["add", "implementation.txt"]);
      git(["commit", "--quiet", "-m", "rebased implementation"]);
      const head = git(["rev-parse", "HEAD"]);
      const completeCommitRange = git([
        "rev-list",
        "--reverse",
        `${base}..${head}`,
      ]).split("\n");
      const fullChangeSet = git([
        "diff",
        "--no-ext-diff",
        "--no-renames",
        "--no-color",
        "--unified=3",
        base,
        head,
      ]);
      const lastCommitOnly = git([
        "diff",
        "--no-ext-diff",
        "--no-renames",
        "--no-color",
        "--unified=3",
        `${head}^`,
        head,
      ]);

      expect(
        haveEquivalentImplementationChanges(originalChange, lastCommitOnly),
      ).toBe(true);
      expect(
        haveEquivalentImplementationChanges(originalChange, fullChangeSet),
      ).toBe(false);
      expect(
        isCompletePullRequestCommitRange(
          completeCommitRange,
          completeCommitRange,
          head,
        ),
      ).toBe(true);
      expect(
        isCompletePullRequestCommitRange([head], completeCommitRange, head),
      ).toBe(false);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
});
