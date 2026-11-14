import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import { GitClient } from "../src/git/git-client.js";
import { cleanupWorktree } from "../src/git/cleanup-worktree.js";
import { completeMergedTaskSessionPullRequest } from "../src/orchestrator/reconcile-terminal-task-session-pr.js";
import { logger } from "../src/logging/logger.js";

let root: string;
afterEach(() => {
  vi.restoreAllMocks();
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
  return { repo, worktree, cleanup, run, project, head };
}
describe("cleanup preservation", () => {
  it("logs only bounded cleanup facts when terminal cleanup encounters a dirty pathname", async () => {
    const f = fixture();
    const canary = "UNTRUSTED_DIRTY_PATH_CANARY";
    fs.writeFileSync(path.join(f.worktree, canary), "preserve me");
    const warn = vi.fn();
    vi.spyOn(logger, "child").mockReturnValue({ warn, info: vi.fn() } as never);
    const git = new GitClient();
    vi.spyOn(git, "getRemoteBranchSha").mockResolvedValue(null);
    await expect(
      completeMergedTaskSessionPullRequest({
        project: { ...f.project, trello: { doneListId: "done" } } as ProjectConfig,
        git,
        trello: {} as never,
        card: { id: "card", idList: "done" } as never,
        pullRequest: {
          state: "MERGED",
          mergedAt: "2026-11-13T00:00:00Z",
          headRefOid: f.head,
          url: "https://github.com/owner/repo/pull/1",
        } as never,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      diagnostic: { reason: "dirty-worktree", artifactReferences: ["process-executions/"] },
    });
    expect(warn).toHaveBeenCalledOnce();
    const diagnostic = String(warn.mock.calls[0]?.[0]);
    expect(diagnostic).not.toContain(canary);
    expect(diagnostic).not.toContain("??");
    expect(diagnostic.length).toBeLessThan(1024);
    expect(diagnostic).toContain("dirty-worktree");
    expect(diagnostic).toContain("process-executions/");
    expect(fs.readFileSync(path.join(f.worktree, canary), "utf8")).toBe("preserve me");
  });
  it.each(["ignored", "untracked", "staged", "committed"])("preserves %s output", async (kind) => {
    const f = fixture();
    const file = path.join(f.worktree, kind === "ignored" ? "ignored" : "output");
    fs.writeFileSync(file, "valuable output");
    if (["staged", "committed"].includes(kind)) f.run(f.worktree, "add", "output");
    if (kind === "committed") f.run(f.worktree, "commit", "-m", "unshipped");
    await expect(f.cleanup()).rejects.toThrow(/dirty worktree|local-only commits/);
    expect(fs.readFileSync(file, "utf8")).toBe("valuable output");
    expect(f.run(f.repo, "show-ref", "--verify", "refs/heads/agent/card")).toBeTruthy();
  });
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
