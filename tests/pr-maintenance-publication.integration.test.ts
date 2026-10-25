import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import { GitClient } from "../src/git/git-client.js";
import type { PullRequestState } from "../src/github/github-client.js";
import { establishCiCheckExpectations } from "../src/github/ci-check-expectations.js";
import { evaluateCiChecks } from "../src/github/evaluate-ci-checks.js";
import {
  maintainOutdatedPr,
  reconcileInterruptedPrMaintenance,
} from "../src/orchestrator/maintain-outdated-pr.js";
import { PrMaintenanceStore } from "../src/task-session/pr-maintenance-store.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import type { ImplementationReviewResult } from "../src/task-session/implementation-review-result.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

let root: string | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("PR maintenance publication integration", () => {
  it("keeps the PR identity, publishes a new head, and requires fresh exact-head CI", async () => {
    root = fs.mkdtempSync(
      path.join(os.tmpdir(), "pr-maintenance-publication-"),
    );
    const remote = path.join(root, "remote.git");
    const repo = path.join(root, "source");
    const worktreeRoot = path.join(root, "worktrees");
    const worktree = path.join(worktreeRoot, "card-1");
    const context = path.join(root, "context");
    fs.mkdirSync(worktreeRoot);
    git(root, "init", "--bare", "--initial-branch=main", remote);
    git(root, "clone", remote, repo);
    git(repo, "config", "user.name", "Agent");
    git(repo, "config", "user.email", "agent@example.test");
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(repo, "add", "base.txt");
    git(repo, "commit", "-m", "base");
    git(repo, "push", "-u", "origin", "main");
    git(repo, "checkout", "-b", "agent/card-1");
    fs.writeFileSync(path.join(repo, "task.txt"), "task\n");
    git(repo, "add", "task.txt");
    git(repo, "commit", "-m", "published task");
    git(repo, "push", "-u", "origin", "agent/card-1");
    const oldHead = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "main");
    git(repo, "worktree", "add", worktree, "agent/card-1");

    const updater = path.join(root, "updater");
    git(root, "clone", remote, updater);
    git(updater, "config", "user.name", "Maintainer");
    git(updater, "config", "user.email", "maintainer@example.test");
    fs.writeFileSync(path.join(updater, "main-only.txt"), "main advanced\n");
    git(updater, "add", "main-only.txt");
    git(updater, "commit", "-m", "advance main");
    git(updater, "push", "origin", "main");
    const oldBase = git(repo, "rev-parse", "refs/remotes/origin/main");
    const newBase = git(updater, "rev-parse", "HEAD");

    const project = {
      id: "project-a",
      autoMerge: false,
      maintenance: { enabled: true },
      repository: {
        path: repo,
        worktreeRoot,
        github: "example/repository",
        defaultBranch: "main",
        validationCommand: "check",
        gitIdentity: { name: "Agent", email: "agent@example.test" },
      },
    } as ProjectConfig;
    const url = "https://github.com/example/repository/pull/42";
    const taskStore = new TaskExecutionStore(context, project);
    const task = taskStore.create({
      version: 1,
      projectId: project.id,
      cardId: "card-1",
      phase: "human-feedback",
      primarySessionId: "session-1",
      expectedBranch: "agent/card-1",
      pullRequest: { number: 42, url, headSha: oldHead },
      operationKey: "published-task",
      revision: 1,
      retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
      createdAt: "2026-10-25T10:00:00.000Z",
      updatedAt: "2026-10-25T10:00:00.000Z",
    });
    const card = {
      id: "card-1",
      name: "Task",
      desc: "",
      idList: "review",
      idLabels: [],
      url: "https://trello.test/card-1",
    } satisfies TrelloCard;
    const currentHead = () =>
      git(remote, "rev-parse", "refs/heads/agent/card-1");
    const prState = (): PullRequestState => ({
      url,
      state: "OPEN",
      mergedAt: null,
      headRefOid: currentHead(),
      baseRefOid: newBase,
      headRefName: "agent/card-1",
      baseRefName: "main",
      headRepository: { name: "repository" },
      headRepositoryOwner: { login: "example" },
    });
    const github = {
      findPullRequestState: vi.fn(async () => prState()),
      findChangesRequestedPullRequest: vi.fn(async () => null),
      getPullRequestConversationComments: vi.fn(async () => []),
    };
    const originalCi = evaluateCiChecks({
      expectedHeadSha: oldHead,
      observedHeadSha: oldHead,
      expectations: establishCiCheckExpectations([
        {
          kind: "workflow-contract",
          sourceId: "checks",
          complete: true,
          checkNames: ["build"],
        },
      ]),
      checks: [
        {
          source: "check-run",
          id: 1,
          name: "build",
          headSha: oldHead,
          status: "completed",
          conclusion: "success",
          url: null,
        },
      ],
    });
    expect(originalCi.status).toBe("passed");

    const mutationQueue = new TaskMutationQueue(context, project);
    const maintenanceStore = new PrMaintenanceStore(context, project);
    const gitClient = new GitClient();
    const leasedPush = vi.spyOn(gitClient, "pushWithLease");
    const compareAndSwap = taskStore.compareAndSwap.bind(taskStore);
    vi.spyOn(taskStore, "compareAndSwap").mockImplementationOnce(() => {
      throw new Error("simulated interrupted local persistence");
    });
    await expect(
      maintainOutdatedPr({
        project,
        card,
        task,
        worktreePath: worktree,
        git: gitClient,
        github,
        commands: {
          run: vi.fn(async () => ({
            exitCode: 0,
            output: "passed",
            errorOutput: "",
          })),
        } as never,
        mutationQueue,
        taskStore,
        maintenanceStore,
        signal: new AbortController().signal,
        eligible: true,
        hasRequestedChanges: false,
        hasUnresolvedFeedback: false,
        requirementIds: ["REQ-1"],
        review: async ({
          contentIdentity,
        }): Promise<ImplementationReviewResult> => ({
          version: 1,
          projectId: project.id,
          cardId: card.id,
          verdict: "pass",
          requirementAssessments: [
            {
              requirementId: "REQ-1",
              status: "satisfied",
              details: "Implemented",
              evidence: ["reviewed source"],
            },
          ],
          blockingFindings: [],
          reviewedContentIdentity: contentIdentity,
        }),
      }),
    ).rejects.toThrow("simulated interrupted local persistence");
    expect(currentHead()).not.toBe(oldHead);
    expect(leasedPush).toHaveBeenCalledTimes(1);
    vi.spyOn(taskStore, "compareAndSwap").mockImplementation(compareAndSwap);
    await reconcileInterruptedPrMaintenance({
      project,
      taskStore,
      maintenanceStore: new PrMaintenanceStore(context, project),
      mutationQueue: new TaskMutationQueue(context, project),
      github,
    });
    expect(leasedPush).toHaveBeenCalledTimes(1);
    const updated = taskStore.read(card.id)!;
    expect(updated.pullRequest).toEqual({
      number: 42,
      url,
      headSha: currentHead(),
    });
    expect(currentHead()).not.toBe(oldHead);
    expect(git(remote, "rev-parse", "refs/heads/agent/card-1")).toBe(
      currentHead(),
    );

    const staleCi = evaluateCiChecks({
      expectedHeadSha: currentHead(),
      observedHeadSha: oldHead,
      expectations: establishCiCheckExpectations([
        {
          kind: "workflow-contract",
          sourceId: "checks",
          complete: true,
          checkNames: ["build"],
        },
      ]),
      checks: [
        {
          source: "check-run",
          id: 1,
          name: "build",
          headSha: oldHead,
          status: "completed",
          conclusion: "success",
          url: null,
        },
      ],
    });
    expect(staleCi.status).toBe("uncertain");

    const freshCiWaiting = evaluateCiChecks({
      expectedHeadSha: currentHead(),
      observedHeadSha: currentHead(),
      expectations: establishCiCheckExpectations([
        {
          kind: "workflow-contract",
          sourceId: "checks",
          complete: true,
          checkNames: ["build"],
        },
      ]),
      checks: [],
    });
    expect(freshCiWaiting.status).toBe("waiting");
    const freshCiPassed = evaluateCiChecks({
      expectedHeadSha: currentHead(),
      observedHeadSha: currentHead(),
      expectations: establishCiCheckExpectations([
        {
          kind: "workflow-contract",
          sourceId: "checks",
          complete: true,
          checkNames: ["build"],
        },
      ]),
      checks: [
        {
          source: "check-run",
          id: 2,
          name: "build",
          headSha: currentHead(),
          status: "completed",
          conclusion: "success",
          url: null,
        },
      ],
    });
    expect(freshCiPassed.status).toBe("passed");
    expect(github.findPullRequestState).toHaveBeenCalledTimes(5);
    expect(oldBase).not.toBe(newBase);
  });
});
