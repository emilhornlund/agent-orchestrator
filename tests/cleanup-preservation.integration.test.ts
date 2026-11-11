import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import { GitClient } from "../src/git/git-client.js";
import { cleanupWorktree } from "../src/git/cleanup-worktree.js";

let root: string;
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-preservation-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  run(repo, "init", "-b", "main");
  run(repo, "config", "user.name", "Test");
  run(repo, "config", "user.email", "test@example.test");
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored\n");
  run(repo, "add", ".");
  run(repo, "commit", "-m", "baseline");
  const head = run(repo, "rev-parse", "HEAD");
  const worktree = path.join(root, "worktrees", "card");
  run(repo, "worktree", "add", "-b", "agent/card", worktree);
  const project = {
    id: "test",
    repository: { path: repo, worktreeRoot: path.dirname(worktree) },
  } as ProjectConfig;
  const cleanup = () =>
    cleanupWorktree({
      git: new GitClient(),
      project,
      worktreePath: worktree,
      branch: "agent/card",
      preservedHeadSha: head,
    });
  return { repo, worktree, cleanup, run };
}
describe("cleanup preservation", () => {
  it.each(["ignored", "untracked", "staged", "committed"])(
    "preserves %s output",
    async (kind) => {
      const f = fixture();
      const file = path.join(
        f.worktree,
        kind === "ignored" ? "ignored" : "output",
      );
      fs.writeFileSync(file, "valuable output");
      if (["staged", "committed"].includes(kind))
        f.run(f.worktree, "add", "output");
      if (kind === "committed") f.run(f.worktree, "commit", "-m", "unshipped");
      await expect(f.cleanup()).rejects.toThrow(
        /dirty worktree|local-only commits/,
      );
      expect(fs.readFileSync(file, "utf8")).toBe("valuable output");
      expect(
        f.run(f.repo, "show-ref", "--verify", "refs/heads/agent/card"),
      ).toBeTruthy();
    },
  );
  it("repeats owned cleanup after both resources are absent", async () => {
    const f = fixture();
    await f.cleanup();
    await f.cleanup();
    expect(fs.existsSync(f.worktree)).toBe(false);
  });
  it("preserves a matching branch in a different repository", async () => {
    const f = fixture();
    f.run(f.repo, "worktree", "remove", f.worktree);
    fs.mkdirSync(f.worktree);
    f.run(f.worktree, "init", "-b", "agent/card");
    await expect(f.cleanup()).rejects.toThrow("canonical repository identity");
    expect(fs.existsSync(f.worktree)).toBe(true);
  });
});
