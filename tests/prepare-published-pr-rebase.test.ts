import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitClient, type RunGit } from "../src/git/git-client.js";
import { createIsolatedGitFixture } from "./support/isolated-git-fixture.js";

let root: string | undefined;
let fixture: ReturnType<typeof createIsolatedGitFixture> | undefined;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
  fixture = undefined;
});

function git(cwd: string, ...args: string[]): string {
  if (fixture === undefined) throw new Error("Git fixture is not initialized");
  return fixture.git(cwd, ...args);
}

describe("P1 published rewrite guard (real Git repository)", () => {
  it("ignores inherited Git and Node process configuration", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "p1-rebase-env-"));
    const hostileConfig = path.join(root, "hostile-gitconfig");
    fs.writeFileSync(
      hostileConfig,
      "[commit]\n\tgpgsign = true\n[core]\n\thooksPath = /hostile/hooks\n",
    );
    const previous = {
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
    };
    process.env.GIT_CONFIG_GLOBAL = hostileConfig;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.NODE_OPTIONS = "--require=/hostile/preload.js";
    try {
      fixture = createIsolatedGitFixture(root);
      expect(fixture.env).not.toHaveProperty("GIT_CONFIG_COUNT");
      expect(fixture.env).not.toHaveProperty("NODE_OPTIONS");
      expect(git(root, "config", "--get", "commit.gpgsign")).toBe("false");
      expect(git(root, "config", "--get", "core.hooksPath")).toBe("/dev/null");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("refuses rebase and leased push without changing refs, objects, or worktree", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "p1-rebase-refusal-"));
    fixture = createIsolatedGitFixture(root);
    const remote = path.join(root, "remote.git");
    const source = path.join(root, "source");
    const worktree = path.join(root, "worktree");
    git(root, "init", "--bare", "--initial-branch=main", remote);
    git(root, "clone", remote, source);
    git(source, "config", "user.name", "Agent");
    git(source, "config", "user.email", "agent@example.test");
    fs.writeFileSync(path.join(source, "base.txt"), "base\n");
    git(source, "add", ".");
    git(source, "commit", "-m", "base");
    git(source, "push", "-u", "origin", "main");
    git(source, "checkout", "-b", "agent/card-1");
    fs.writeFileSync(path.join(source, "task.txt"), "published\n");
    git(source, "add", ".");
    git(source, "commit", "-m", "task");
    git(source, "push", "-u", "origin", "agent/card-1");
    const taskHead = git(source, "rev-parse", "HEAD");
    git(source, "worktree", "add", "--detach", worktree, "agent/card-1");
    fs.writeFileSync(path.join(worktree, "unshipped.txt"), "keep me\n");

    const history: string[][] = [];
    const runGit: RunGit = async (cwd, args) => {
      history.push([...args]);
      return git(cwd, ...args);
    };
    const client = new GitClient(runGit);
    const refsBefore = git(source, "show-ref");
    const objectsBefore = git(source, "count-objects", "-v");
    const statusBefore = git(worktree, "status", "--porcelain=v1");
    const commandsBefore = history.length;

    await expect(
      client.rebase(worktree, "origin/main", {
        name: "Agent",
        email: "agent@example.test",
      }),
    ).rejects.toThrow("disabled by the P1 safety guardrail");
    await expect(
      client.pushWithLease(worktree, "origin", "agent/card-1", taskHead),
    ).rejects.toThrow("Force-with-lease pushes are disabled");

    expect(history).toHaveLength(commandsBefore);
    expect(history.flat().join(" ")).not.toMatch(
      /(?:rebase|reset|clean|--force)/,
    );
    expect(git(source, "show-ref")).toBe(refsBefore);
    expect(git(source, "count-objects", "-v")).toBe(objectsBefore);
    expect(git(worktree, "status", "--porcelain=v1")).toBe(statusBefore);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(taskHead);
    expect(fs.readFileSync(path.join(worktree, "unshipped.txt"), "utf8")).toBe(
      "keep me\n",
    );
  });
});
