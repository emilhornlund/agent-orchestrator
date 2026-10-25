import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import { GitClient } from "../src/git/git-client.js";
import type { PullRequestState } from "../src/github/github-client.js";
import { preparePublishedPrRebase } from "../src/task-session/prepare-published-pr-rebase.js";
import { PrMaintenanceStore } from "../src/task-session/pr-maintenance-store.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";

let temporaryRoot: string | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  if (temporaryRoot !== undefined)
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

function command(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createFixture(
  options: { conflict?: boolean; alreadyCurrent?: boolean } = {},
) {
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pr-rebase-preparation-"),
  );
  const bare = path.join(temporaryRoot, "remote.git");
  const repositoryPath = path.join(temporaryRoot, "source");
  const worktreeRoot = path.join(temporaryRoot, "worktrees");
  const worktreePath = path.join(worktreeRoot, "card-1");
  fs.mkdirSync(worktreeRoot);
  command(temporaryRoot, "init", "--bare", "--initial-branch=main", bare);
  command(temporaryRoot, "clone", bare, repositoryPath);
  command(repositoryPath, "config", "user.name", "Test Agent");
  command(repositoryPath, "config", "user.email", "agent@example.test");
  fs.writeFileSync(path.join(repositoryPath, "shared.txt"), "base\n", "utf8");
  command(repositoryPath, "add", "shared.txt");
  command(repositoryPath, "commit", "-m", "base");
  command(repositoryPath, "push", "-u", "origin", "main");
  const baseSha = command(repositoryPath, "rev-parse", "HEAD");
  command(repositoryPath, "checkout", "-b", "agent/card-1");
  fs.writeFileSync(
    path.join(repositoryPath, "task.txt"),
    "task work\n",
    "utf8",
  );
  if (options.conflict)
    fs.writeFileSync(
      path.join(repositoryPath, "shared.txt"),
      "task version\n",
      "utf8",
    );
  command(
    repositoryPath,
    "add",
    "task.txt",
    ...(options.conflict ? ["shared.txt"] : []),
  );
  command(repositoryPath, "commit", "-m", "published task work");
  command(repositoryPath, "push", "-u", "origin", "agent/card-1");
  const publishedHead = command(repositoryPath, "rev-parse", "HEAD");
  command(repositoryPath, "checkout", "main");
  command(repositoryPath, "worktree", "add", worktreePath, "agent/card-1");

  if (!options.alreadyCurrent) {
    const updater = path.join(temporaryRoot, "updater");
    command(temporaryRoot, "clone", bare, updater);
    command(updater, "config", "user.name", "Base Maintainer");
    command(updater, "config", "user.email", "base@example.test");
    if (options.conflict)
      fs.writeFileSync(
        path.join(updater, "shared.txt"),
        "base version\n",
        "utf8",
      );
    else
      fs.writeFileSync(
        path.join(updater, "base-only.txt"),
        "new base\n",
        "utf8",
      );
    command(updater, "add", options.conflict ? "shared.txt" : "base-only.txt");
    command(updater, "commit", "-m", "advance base");
    command(updater, "push", "origin", "main");
  }

  const project = {
    id: "project-a",
    repository: {
      path: repositoryPath,
      worktreeRoot,
      github: "example/repository",
      defaultBranch: "main",
      gitIdentity: { name: "Test Agent", email: "agent@example.test" },
    },
  } as ProjectConfig;
  const contextRoot = path.join(temporaryRoot, "context");
  const maintenanceStore = new PrMaintenanceStore(contextRoot, project);
  const taskExecutionStore = new TaskExecutionStore(contextRoot, project);
  const pullRequestUrl = "https://github.com/example/repository/pull/42";
  taskExecutionStore.create({
    version: 1,
    projectId: project.id,
    cardId: "card-1",
    phase: "ci",
    primarySessionId: "session-1",
    expectedBranch: "agent/card-1",
    pullRequest: { number: 42, url: pullRequestUrl, headSha: publishedHead },
    operationKey: "published-task",
    revision: 1,
    retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
    createdAt: "2026-10-25T10:00:00.000Z",
    updatedAt: "2026-10-25T10:00:00.000Z",
  });
  maintenanceStore.create({
    projectId: project.id,
    cardId: "card-1",
    pullRequest: { number: 42, url: pullRequestUrl },
    expectedRemoteHead: publishedHead,
    targetBaseHead: baseSha,
    operationId: "maintenance-1",
    createdAt: "2026-10-25T10:00:00.000Z",
    updatedAt: "2026-10-25T10:00:00.000Z",
  });
  const identity = {
    projectId: project.id,
    cardId: "card-1",
    pullRequest: { number: 42, url: pullRequestUrl },
    expectedRemoteHead: publishedHead,
    targetBaseHead: baseSha,
  };
  maintenanceStore.advance("maintenance-1", "prepared", "active", identity);
  const github = {
    findPullRequestState: vi.fn(
      async () =>
        ({
          url: pullRequestUrl,
          state: "OPEN",
          mergedAt: null,
          headRefOid: publishedHead,
          headRefName: "agent/card-1",
          baseRefName: "main",
          headRepository: { name: "repository" },
          headRepositoryOwner: { login: "example" },
        }) satisfies PullRequestState,
    ),
  };
  const git = new GitClient();
  const run = (overrides: Record<string, unknown> = {}) =>
    preparePublishedPrRebase({
      project,
      cardId: "card-1",
      operationId: "maintenance-1",
      worktreePath,
      maintenanceStore,
      taskExecutionStore,
      git,
      github,
      ...overrides,
    } as Parameters<typeof preparePublishedPrRebase>[0]);
  return {
    project,
    repositoryPath,
    worktreePath,
    contextRoot,
    publishedHead,
    baseSha,
    maintenanceStore,
    taskExecutionStore,
    git,
    github,
    run,
  };
}

describe("preparePublishedPrRebase", () => {
  it("fetches the authoritative base, rebases locally, and preserves the original published commit", async () => {
    const f = createFixture();
    const result = await f.run();
    expect(result.status).toBe("prepared");
    if (result.status === "conflicted") throw new Error("unexpected conflict");
    expect(result.originalHead).toBe(f.publishedHead);
    expect(result.resultingHead).not.toBe(f.publishedHead);
    expect(await f.git.getRefSha(f.repositoryPath, result.backupRef!)).toBe(
      f.publishedHead,
    );
    expect(
      await f.git.isAncestor(
        f.worktreePath,
        result.baseHead,
        result.resultingHead,
      ),
    ).toBe(true);
    expect(f.taskExecutionStore.read("card-1")?.pullRequest?.headSha).toBe(
      f.publishedHead,
    );
    expect(
      f.maintenanceStore.inspect("maintenance-1")?.localPreparation
        ?.resultingHead,
    ).toBe(result.resultingHead);
  });

  it("records an already-current task branch without creating a backup or rebasing", async () => {
    const f = createFixture({ alreadyCurrent: true });
    const result = await f.run();
    if (result.status !== "already-current")
      throw new Error("expected already-current result");
    expect(result.resultingHead).toBe(f.publishedHead);
    expect(
      f.maintenanceStore.inspect("maintenance-1")?.localPreparation?.backupRef,
    ).toBeUndefined();
  });

  it("rejects wrong card and branch identities before changing Git state", async () => {
    const f = createFixture();
    await expect(f.run({ cardId: "another-card" })).rejects.toThrow(
      /project\/card/,
    );
    const wrongBranch = Object.create(f.git) as GitClient;
    wrongBranch.getCurrentBranch = async () => "feature/unowned";
    await expect(f.run({ git: wrongBranch })).rejects.toThrow(
      /owned task branch/,
    );
  });

  it("requires the current exclusive owner and exact authoritative PR head", async () => {
    const f = createFixture();
    const competingStore = new PrMaintenanceStore(f.contextRoot, f.project);
    await expect(f.run({ maintenanceStore: competingStore })).rejects.toThrow(
      /live owner|exclusive maintenance ownership/,
    );
    vi.spyOn(f.github, "findPullRequestState").mockResolvedValue({
      url: "https://github.com/example/repository/pull/42",
      state: "OPEN",
      mergedAt: null,
      headRefOid: "f".repeat(40),
      headRefName: "agent/card-1",
      baseRefName: "main",
      headRepository: { name: "repository" },
      headRepositoryOwner: { login: "example" },
    });
    await expect(f.run()).rejects.toThrow(/published head is ambiguous/);
    expect(await f.git.getHeadSha(f.worktreePath)).toBe(f.publishedHead);
  });

  it("refuses untracked local changes without discarding them", async () => {
    const f = createFixture();
    fs.writeFileSync(
      path.join(f.worktreePath, "unknown.txt"),
      "keep me",
      "utf8",
    );
    await expect(f.run()).rejects.toThrow(/dirty, conflicted/);
    expect(
      fs.readFileSync(path.join(f.worktreePath, "unknown.txt"), "utf8"),
    ).toBe("keep me");
  });

  it("preserves progress and the original branch when fetching the base fails", async () => {
    const f = createFixture();
    const failingGit = Object.create(f.git) as GitClient;
    failingGit.fetch = async () => {
      throw new Error("offline");
    };
    await expect(f.run({ git: failingGit })).rejects.toThrow("offline");
    expect(await f.git.getHeadSha(f.worktreePath)).toBe(f.publishedHead);
    expect(
      f.maintenanceStore.inspect("maintenance-1")?.localPreparation?.status,
    ).toBe("fetching-base");
  });

  it("preserves a conflict handoff and backup without resolving or aborting it", async () => {
    const f = createFixture({ conflict: true });
    const result = await f.run();
    expect(result.status).toBe("conflicted");
    if (result.status !== "conflicted")
      throw new Error("expected conflict handoff");
    expect(result.conflictedPaths).toContain("shared.txt");
    expect(
      f.maintenanceStore.inspect("maintenance-1")?.localPreparation?.status,
    ).toBe("conflicted");
    expect(await f.git.getRefSha(f.repositoryPath, result.backupRef)).toBe(
      f.publishedHead,
    );
    expect(await f.git.getRebaseState(f.worktreePath)).not.toBeNull();
    expect((await f.run()).status).toBe("conflicted");
  });

  it("safely recovers a rebase that completed before its final progress write", async () => {
    const f = createFixture();
    await f.git.fetch(f.repositoryPath, "origin", "main", f.project);
    const baseHead = await f.git.resolveCommitSha(
      f.repositoryPath,
      "refs/remotes/origin/main",
    );
    const backupRef = "refs/orchestrator/pr-maintenance/recovery/original";
    f.maintenanceStore.recordLocalPreparation(
      "maintenance-1",
      {
        projectId: "project-a",
        cardId: "card-1",
        pullRequest: {
          number: 42,
          url: "https://github.com/example/repository/pull/42",
        },
        expectedRemoteHead: f.publishedHead,
        targetBaseHead: f.baseSha,
      },
      {
        status: "rebasing",
        originalHead: f.publishedHead,
        baseHead,
        backupRef,
        updatedAt: new Date().toISOString(),
      },
    );
    await f.git.createRefIfAbsent(f.repositoryPath, backupRef, f.publishedHead);
    await f.git.rebase(
      f.worktreePath,
      baseHead,
      f.project.repository.gitIdentity,
    );
    const statePath = path.join(
      f.contextRoot,
      "pr-maintenance",
      "project-a.json",
    );
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      operations: Array<{ ownerToken: string; ownerPid: number }>;
    };
    state.operations[0]!.ownerToken = "00000000-0000-4000-8000-000000000099";
    state.operations[0]!.ownerPid = 2_147_483_647;
    fs.writeFileSync(statePath, JSON.stringify(state));
    const restartedStore = new PrMaintenanceStore(f.contextRoot, f.project);
    const result = await f.run({ maintenanceStore: restartedStore });
    expect(result.status).toBe("prepared");
    if (result.status === "conflicted") throw new Error("unexpected conflict");
    expect(result.resultingHead).toBe(await f.git.getHeadSha(f.worktreePath));
    expect(
      restartedStore.inspect("maintenance-1")?.localPreparation?.status,
    ).toBe("prepared");
    expect(await f.git.getRefSha(f.repositoryPath, backupRef)).toBe(
      f.publishedHead,
    );
  });
});
