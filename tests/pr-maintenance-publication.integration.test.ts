import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitClient } from "../src/git/git-client.js";
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

describe("unsafe maintenance refusal (real Git remote)", () => {
  it("observes a real accepted push by exact remote head without dispatching a second push", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "accepted-push-"));
    fixture = createIsolatedGitFixture(root);
    const remote = path.join(root, "remote.git");
    const repo = path.join(root, "repo");
    git(root, "init", "--bare", "--initial-branch=main", remote);
    git(root, "clone", remote, repo);
    git(repo, "config", "user.name", "Agent");
    git(repo, "config", "user.email", "agent@example.test");
    fs.writeFileSync(path.join(repo, "task.txt"), "task\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "task");
    git(repo, "branch", "agent/card-1");
    git(repo, "checkout", "agent/card-1");
    const taskHead = git(repo, "rev-parse", "HEAD");
    let pushAccepted = false;
    const pushCalls: number[] = [];
    const client = new GitClient(async (cwd, args) => {
      if (args[0] === "push") {
        pushCalls.push(1);
        const output = git(cwd, ...args);
        if (!pushAccepted) {
          pushAccepted = true;
          throw new Error(
            "simulated acknowledgement loss after remote acceptance",
          );
        }
        return output.trim();
      }
      return git(cwd, ...args);
    });

    await expect(client.push(repo, "origin", "agent/card-1")).rejects.toThrow(
      "simulated acknowledgement loss",
    );
    expect(
      await client.getRemoteBranchSha(repo, "origin", "agent/card-1"),
    ).toBe(taskHead);
    // An authoritative exact-head read reconciles the accepted effect; do not
    // dispatch the uncertain push a second time.
    expect(pushCalls).toHaveLength(1);
    expect(
      git(repo, "ls-remote", "origin", "refs/heads/agent/card-1"),
    ).toContain(taskHead);
  });

  it("does not infer unpublished history from a deleted branch and preserves local evidence", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "deleted-pr-branch-"));
    fixture = createIsolatedGitFixture(root);
    const remote = path.join(root, "remote.git");
    const repo = path.join(root, "repo");
    const task = path.join(root, "task");
    const unrelated = path.join(root, "unrelated");
    git(root, "init", "--bare", "--initial-branch=main", remote);
    git(root, "clone", remote, repo);
    git(repo, "config", "user.name", "Agent");
    git(repo, "config", "user.email", "agent@example.test");
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");
    git(repo, "push", "-u", "origin", "main");
    git(repo, "checkout", "-b", "agent/card-1");
    fs.writeFileSync(path.join(repo, "task.txt"), "historically published\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "published task");
    git(repo, "push", "-u", "origin", "agent/card-1");
    const historicalHead = git(repo, "rev-parse", "HEAD");
    git(repo, "worktree", "add", "--detach", task, "agent/card-1");
    git(repo, "checkout", "main");
    git(repo, "worktree", "add", "--detach", unrelated, "main");
    git(repo, "push", "origin", "--delete", "agent/card-1");
    fs.writeFileSync(path.join(task, "dirty.txt"), "preserve dirty work\n");
    const history: string[][] = [];
    const client = new GitClient(async (cwd, args) => {
      history.push([...args]);
      return git(cwd, ...args);
    });
    const taskRefsBefore = git(repo, "show-ref");
    const unrelatedHead = git(unrelated, "rev-parse", "HEAD");
    const objectsBefore = git(repo, "count-objects", "-v");

    await expect(
      client.rebase(task, "origin/main", {
        name: "Agent",
        email: "agent@example.test",
      }),
    ).rejects.toThrow("disabled to protect published history");

    expect(git(repo, "ls-remote", "origin", "refs/heads/agent/card-1")).toBe(
      "",
    );
    expect(git(repo, "show-ref")).toBe(taskRefsBefore);
    expect(git(repo, "count-objects", "-v")).toBe(objectsBefore);
    expect(git(task, "rev-parse", "HEAD")).toBe(historicalHead);
    expect(git(unrelated, "rev-parse", "HEAD")).toBe(unrelatedHead);
    expect(git(task, "status", "--porcelain=v1")).toContain("dirty.txt");
    expect(history.flat().join(" ")).not.toMatch(
      /(?:rebase|reset|clean|--force)/,
    );
  });
});
