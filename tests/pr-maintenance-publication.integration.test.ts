import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { PrMaintenanceStore } from "../src/task-session/pr-maintenance-store.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import { CommandRunner } from "../src/process/command-runner.js";
import {
  reconcileManagedPullRequestStatus,
  type ManagedPullRequestStatus,
} from "../src/github/pull-request-status.js";
import {
  maintainOutdatedPr,
  reconcileInterruptedPrMaintenance,
  type MaintainOutdatedPrOptions,
} from "../src/orchestrator/maintain-outdated-pr.js";
import { GitClient } from "../src/git/git-client.js";
import { createIsolatedGitFixture } from "./support/isolated-git-fixture.js";

let root: string | undefined;
let fixture: ReturnType<typeof createIsolatedGitFixture> | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
  fixture = undefined;
});
function git(cwd: string, ...args: string[]): string {
  if (fixture === undefined) throw new Error("Git fixture is not initialized");
  return fixture.git(cwd, ...args);
}

async function publishedTask(conflict = false) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "additive-maintenance-"));
  fixture = createIsolatedGitFixture(root);
  const remote = path.join(root, "remote.git"),
    source = path.join(root, "source"),
    worktree = path.join(root, "worktrees", "card");
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "clone", remote, source);
  git(source, "config", "user.name", "Agent");
  git(source, "config", "user.email", "agent@example.test");
  fs.writeFileSync(path.join(source, "base.txt"), "base\n");
  fs.writeFileSync(path.join(source, "setup.txt"), "clean setup\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "base");
  git(source, "push", "origin", "main");
  fs.mkdirSync(path.dirname(worktree));
  git(source, "worktree", "add", "-b", "agent/card", worktree, "main");
  fs.writeFileSync(path.join(worktree, conflict ? "base.txt" : "task.txt"), "published task\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "-m", "published task");
  git(worktree, "push", "origin", "agent/card");
  const published = git(worktree, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(source, conflict ? "base.txt" : "upstream.txt"), "upstream change\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "advance target");
  git(source, "push", "origin", "main");
  const base = git(source, "rev-parse", "HEAD");
  const project = {
    id: "project",
    repository: {
      path: source,
      worktreeRoot: path.dirname(worktree),
      github: "owner/repo",
      defaultBranch: "main",
      gitIdentity: { name: "Agent", email: "agent@example.test" },
      validationCommand: "test",
    },
    opencode: { timeoutMinutes: 1, remediation: { maxPasses: 1 } },
    trello: { reviewListId: "review" },
  } as ProjectConfig;
  const state = path.join(root, "state");
  const taskStore = new TaskExecutionStore(state, project),
    maintenanceStore = new PrMaintenanceStore(state, project),
    mutationQueue = new TaskMutationQueue(state, project);
  const task = taskStore.create({
    version: 1,
    projectId: project.id,
    cardId: "card",
    phase: "human-feedback",
    primarySessionId: "primary",
    sessionCreationStatus: "bound",
    expectedBranch: "agent/card",
    operationKey: "task",
    pullRequest: {
      number: 1,
      url: "https://github.com/owner/repo/pull/1",
      headSha: published,
    },
    retryCounters: { ci: 0, validation: 0, review: 0, humanFeedback: 0 },
    revision: 1,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
  });
  const client = new GitClient(async (cwd, args) => git(cwd, ...args));
  let terminal: "OPEN" | "CLOSED" = "OPEN";
  let body = "Human summary\n\nOriginal task implementation";
  const github = {
    updatePullRequestDescriptionStatus: vi.fn(
      async ({ status }: { status: ManagedPullRequestStatus | null }) => {
        body = reconcileManagedPullRequestStatus(body, status, "main");
        return true;
      },
    ),
    ensurePullRequestDraft: vi.fn(async () => undefined),
    getPullRequestDescription: vi.fn(async () => body),
    editPullRequestDescription: vi.fn(
      async ({ body: next, expectedBody }: { body: string; expectedBody?: string | undefined }) => {
        expect(body).toBe(expectedBody);
        body = next;
      },
    ),
    findPullRequestState: vi.fn(async () => ({
      url: task.pullRequest!.url,
      state: terminal,
      mergedAt: null,
      isDraft: false,
      reviewDecision: "APPROVED",
      headRefName: "agent/card",
      baseRefName: "main",
      headRefOid: git(source, "ls-remote", "origin", "refs/heads/agent/card").split(/\s/u)[0] ?? "",
      headRepository: { name: "repo" },
      headRepositoryOwner: { login: "owner" },
    })),
    getBaseBranchHeadSha: vi.fn(async () => base),
    findChangesRequestedPullRequest: vi.fn(async () => null),
    getPullRequestConversationComments: vi.fn(async () => []),
  };
  const options: MaintainOutdatedPrOptions = {
    project,
    task,
    card: {
      id: "card",
      name: "Task",
      desc: "Keep the task",
      idList: "review",
      idLabels: [],
      url: "https://trello.example/card",
    },
    worktreePath: worktree,
    git: client,
    github,
    commands: new CommandRunner(async () => ({
      exitCode: 0,
      output: "passed",
      errorOutput: "",
    })),
    taskStore,
    maintenanceStore,
    mutationQueue,
    signal: new AbortController().signal,
    eligible: true,
    hasRequestedChanges: false,
    hasUnresolvedFeedback: false,
    requirementIds: ["REQ-1"],
    review: vi.fn<MaintainOutdatedPrOptions["review"]>(async ({ contentIdentity }) => ({
      version: 1,
      projectId: project.id,
      cardId: "card",
      reviewedContentIdentity: contentIdentity,
      verdict: "pass",
      blockingFindings: [],
      requirementAssessments: [
        {
          requirementId: "REQ-1",
          status: "satisfied",
          details: "Preserved",
          evidence: ["task.txt"],
        },
      ],
    })),
  };
  return {
    options,
    source,
    worktree,
    published,
    base,
    state,
    github,
    terminal: () => {
      terminal = "CLOSED";
    },
  };
}

describe("additive published PR maintenance", () => {
  it.each(["validation", "review", "unavailable", "unconfigured"] as const)(
    "publishes additive maintenance despite %s advisory results with truthful draft evidence",
    async (kind) => {
      const f = await publishedTask();
      if (kind === "validation")
        f.options.commands = new CommandRunner(async () => ({
          exitCode: 1,
          output: "Observed failure",
          errorOutput: "",
        }));
      if (kind === "unconfigured") delete f.options.project.repository.validationCommand;
      if (kind === "unavailable")
        f.options.review = vi.fn(async () => {
          throw new Error("Independent review unavailable");
        });
      if (kind === "review")
        f.options.review = async ({ contentIdentity }) => ({
          version: 1,
          projectId: "project",
          cardId: "card",
          reviewedContentIdentity: contentIdentity,
          verdict: "fail",
          requirementAssessments: [
            {
              requirementId: "REQ-1",
              status: "unsatisfied",
              details: "A material concern remains",
              evidence: ["task.txt"],
            },
          ],
          blockingFindings: [],
        });
      expect(await maintainOutdatedPr(f.options)).toBe("completed");
      expect(f.github.ensurePullRequestDraft).toHaveBeenCalled();
      const body = await f.github.getPullRequestDescription();
      expect(body).toContain("Human summary\n\nOriginal task implementation");
      expect(body).toContain("Current automation outcome");
      expect(body).toContain("CI for this revision has not yet been verified");
      expect(f.options.maintenanceStore.inspect()[0]?.qualityVerification?.status).toBe(
        "uncertain",
      );
      expect(git(f.source, "ls-remote", "origin", "refs/heads/agent/card")).toContain(
        git(f.worktree, "rev-parse", "HEAD"),
      );
    },
  );

  it("preserves staged unrelated output and refuses its inclusion in a merge commit", async () => {
    const f = await publishedTask();
    fs.writeFileSync(path.join(f.worktree, "setup.txt"), "unrelated staged output\n");
    git(f.worktree, "add", "setup.txt");
    const index = git(f.worktree, "write-tree");
    expect(await maintainOutdatedPr(f.options)).toBe("blocked");
    expect(git(f.worktree, "write-tree")).toBe(index);
    expect(git(f.worktree, "rev-parse", "HEAD")).toBe(f.published);
    git(f.worktree, "restore", "--staged", "setup.txt");
    expect(await maintainOutdatedPr(f.options)).toBe("completed");
    expect(fs.readFileSync(path.join(f.worktree, "setup.txt"), "utf8")).toBe(
      "unrelated staged output\n",
    );
    expect(git(f.worktree, "show", "HEAD:setup.txt")).toBe("clean setup");
  });

  it("retains an unexpected remote advance without overwriting it", async () => {
    const f = await publishedTask();
    const push = vi.spyOn(f.options.git, "push");
    const originalReview = f.options.review;
    let externalHead = "";
    f.options.review = async (input) => {
      const human = path.join(path.dirname(f.source), "human");
      git(path.dirname(f.source), "clone", git(f.source, "remote", "get-url", "origin"), human);
      git(human, "checkout", "agent/card");
      git(human, "config", "user.name", "Human");
      git(human, "config", "user.email", "human@example.test");
      fs.writeFileSync(path.join(human, "human.txt"), "independent external work\n");
      git(human, "add", ".");
      git(human, "commit", "-m", "human work");
      git(human, "push", "origin", "agent/card");
      externalHead = git(human, "rev-parse", "HEAD");
      return originalReview(input);
    };
    await expect(maintainOutdatedPr(f.options)).rejects.toThrow("published head changed");
    expect(push).not.toHaveBeenCalled();
    expect(git(f.source, "ls-remote", "origin", "refs/heads/agent/card")).toContain(externalHead);
  });

  it("merges the latest target on an approved open PR without rewriting commits or shipping dirty setup output", async () => {
    const f = await publishedTask();
    const task = f.options.taskStore.read("card")!;
    f.options.taskStore.compareAndSwap("card", task.revision, {
      ...task,
      ciRepair: {
        cycleId: "exhausted-episode",
        headSha: f.published,
        status: "exhausted",
        maxAttempts: 2,
      },
      retryCounters: { ...task.retryCounters, ci: 2 },
      revision: task.revision + 1,
    });
    f.options.task = f.options.taskStore.read("card")!;
    const sourceHead = git(f.source, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(f.worktree, "setup.txt"), "excluded setup output\n");
    fs.writeFileSync(path.join(f.worktree, "scratch.txt"), "unshipped scratch\n");
    expect(await maintainOutdatedPr(f.options)).toBe("completed");
    const head = git(f.worktree, "rev-parse", "HEAD");
    expect(git(f.worktree, "show", "-s", "--format=%P", head)).toBe(`${f.published} ${f.base}`);
    expect(git(f.worktree, "show", "HEAD:task.txt")).toBe("published task");
    expect(git(f.worktree, "show", "HEAD:setup.txt")).toBe("clean setup");
    expect(fs.readFileSync(path.join(f.worktree, "setup.txt"), "utf8")).toBe(
      "excluded setup output\n",
    );
    expect(fs.readFileSync(path.join(f.worktree, "scratch.txt"), "utf8")).toBe(
      "unshipped scratch\n",
    );
    expect(git(f.source, "rev-parse", "HEAD")).toBe(sourceHead);
    expect(f.options.taskStore.read("card")?.pullRequest?.headSha).toBe(head);
    expect(f.options.taskStore.read("card")).toMatchObject({
      retryCounters: { ci: 2 },
      ciRepair: { cycleId: "exhausted-episode", status: "exhausted" },
    });
    expect(f.options.maintenanceStore.inspect()[0]).toMatchObject({
      strategy: "merge",
      status: "completed",
      expectedRemoteHead: f.published,
      targetBaseHead: f.base,
      publication: { status: "verified" },
    });
    expect(
      f.github.updatePullRequestDescriptionStatus.mock.calls.map(([request]) => request.status),
    ).toEqual(["synchronizing-target", "validating-pr-changes", "updating-remote", null]);
  });

  it.each(["merge", "push"] as const)(
    "reconciles an accepted %s interrupted before its acknowledgement without repeating it",
    async (boundary) => {
      const f = await publishedTask();
      const originalMerge = f.options.git.completeTargetMerge.bind(f.options.git);
      const originalPush = f.options.git.push.bind(f.options.git);
      const merge = vi.spyOn(f.options.git, "completeTargetMerge"),
        push = vi.spyOn(f.options.git, "push");
      if (boundary === "merge") {
        merge.mockImplementationOnce(async (...args) => {
          await originalMerge(...args);
          throw new Error("merge acknowledgement lost");
        });
        await expect(maintainOutdatedPr(f.options)).rejects.toThrow("merge acknowledgement lost");
      } else {
        push.mockImplementationOnce(async (...args) => {
          await originalPush(...args);
          f.github.findPullRequestState.mockRejectedValueOnce(new Error("read outage after push"));
          throw new Error("push acknowledgement lost");
        });
        await expect(maintainOutdatedPr(f.options)).rejects.toThrow("read outage after push");
      }
      const options = {
        ...f.options,
        taskStore: new TaskExecutionStore(f.state, f.options.project),
        maintenanceStore: new PrMaintenanceStore(f.state, f.options.project),
        mutationQueue: new TaskMutationQueue(f.state, f.options.project),
      };
      await reconcileInterruptedPrMaintenance(options);
      options.task = options.taskStore.read("card")!;
      expect(await maintainOutdatedPr(options)).toBe("completed");
      expect(merge).toHaveBeenCalledOnce();
      expect(push).toHaveBeenCalledOnce();
      expect(options.taskStore.read("card")?.pullRequest?.headSha).toBe(
        git(f.worktree, "rev-parse", "HEAD"),
      );
    },
  );

  it("uses bounded conflict assistance and retains its exact operation on interrupted primary completion", async () => {
    const f = await publishedTask(true);
    let stopped = false;
    const operations: string[] = [];
    f.options.remediateConflict = async ({ conflictedPaths, operationId }) => {
      operations.push(operationId);
      expect(conflictedPaths).toEqual(["base.txt"]);
      fs.writeFileSync(path.join(f.worktree, "base.txt"), "published task plus upstream change\n");
      if (!stopped) {
        stopped = true;
        throw new Error("primary completion interrupted");
      }
    };
    await expect(maintainOutdatedPr(f.options)).rejects.toThrow("primary completion interrupted");
    expect(git(f.worktree, "rev-parse", "MERGE_HEAD")).toBe(f.base);
    expect(await maintainOutdatedPr(f.options)).toBe("completed");
    expect(new Set(operations).size).toBe(1);
    expect(f.options.maintenanceStore.inspect()[0]?.conflictRemediationAttempts).toBe(1);
    expect(git(f.worktree, "show", "HEAD:base.txt")).toBe("published task plus upstream change");
  });

  it("retains unresolved conflicts at the configured bound without repeated assistance", async () => {
    const f = await publishedTask(true);
    f.options.project.opencode.remediation.maxPasses = 0;
    const repair = vi.fn();
    f.options.remediateConflict = repair;
    expect(await maintainOutdatedPr(f.options)).toBe("blocked");
    expect(await maintainOutdatedPr(f.options)).toBe("blocked");
    expect(repair).not.toHaveBeenCalled();
    expect(await f.github.getPullRequestDescription()).not.toContain("Agent Orchestrator status:");
    expect(git(f.worktree, "rev-parse", "HEAD")).toBe(f.published);
    expect(git(f.worktree, "rev-parse", "MERGE_HEAD")).toBe(f.base);
  });

  it("does not absorb unrelated staged output when a bounded conflict is manually resolved", async () => {
    const f = await publishedTask(true);
    f.options.project.opencode.remediation.maxPasses = 0;
    expect(await maintainOutdatedPr(f.options)).toBe("blocked");
    fs.writeFileSync(path.join(f.worktree, "base.txt"), "human resolution\n");
    fs.writeFileSync(path.join(f.worktree, "unrelated.txt"), "retain unrelated work\n");
    git(f.worktree, "add", "base.txt", "unrelated.txt");
    await expect(maintainOutdatedPr(f.options)).rejects.toThrow("non-conflict");
    expect(git(f.worktree, "rev-parse", "HEAD")).toBe(f.published);
    expect(fs.readFileSync(path.join(f.worktree, "unrelated.txt"), "utf8")).toBe(
      "retain unrelated work\n",
    );
  });

  it("fences unrelated changes after an interrupted merge before its conflict checkpoint", async () => {
    const f = await publishedTask(true);
    const record = f.options.maintenanceStore.recordLocalPreparation.bind(
      f.options.maintenanceStore,
    );
    let interrupted = false;
    vi.spyOn(f.options.maintenanceStore, "recordLocalPreparation").mockImplementation(
      (id, identity, progress) => {
        if (progress.status === "conflicted" && !interrupted) {
          interrupted = true;
          throw new Error("Interrupted before conflict checkpoint");
        }
        return record(id, identity, progress);
      },
    );
    await expect(maintainOutdatedPr(f.options)).rejects.toThrow(
      "Interrupted before conflict checkpoint",
    );
    fs.writeFileSync(path.join(f.worktree, "unrelated.txt"), "preserve new unrelated work\n");
    git(f.worktree, "add", "unrelated.txt");
    const repair = vi.fn();
    f.options.remediateConflict = repair;
    await expect(maintainOutdatedPr(f.options)).rejects.toThrow("non-conflict");
    expect(repair).not.toHaveBeenCalled();
    expect(git(f.worktree, "rev-parse", "HEAD")).toBe(f.published);
    expect(git(f.worktree, "rev-parse", "MERGE_HEAD")).toBe(f.base);
  });

  it("stops no-op conflict assistance without staging unchanged conflict markers or dispatching another writer", async () => {
    const f = await publishedTask(true);
    const repair = vi.fn(async () => undefined);
    f.options.remediateConflict = repair;
    expect(await maintainOutdatedPr(f.options)).toBe("blocked");
    expect(await maintainOutdatedPr(f.options)).toBe("blocked");
    expect(repair).toHaveBeenCalledOnce();
    expect(git(f.worktree, "rev-parse", "HEAD")).toBe(f.published);
    expect(git(f.worktree, "diff", "--name-only", "--diff-filter=U")).toBe("base.txt");
  });

  it("does not absorb unrelated staged work after an interruption following conflict staging", async () => {
    const f = await publishedTask(true);
    f.options.remediateConflict = async () => {
      fs.writeFileSync(path.join(f.worktree, "base.txt"), "combined resolution\n");
    };
    const stage = f.options.git.stagePaths.bind(f.options.git);
    vi.spyOn(f.options.git, "stagePaths").mockImplementationOnce(async (...args) => {
      await stage(...args);
      throw new Error("stopped after staging");
    });
    await expect(maintainOutdatedPr(f.options)).rejects.toThrow("stopped after staging");
    fs.writeFileSync(path.join(f.worktree, "setup.txt"), "unrelated later work\n");
    git(f.worktree, "add", "setup.txt");
    await expect(maintainOutdatedPr(f.options)).rejects.toThrow("non-conflict path");
    expect(git(f.worktree, "rev-parse", "HEAD")).toBe(f.published);
    expect(fs.readFileSync(path.join(f.worktree, "setup.txt"), "utf8")).toBe(
      "unrelated later work\n",
    );
  });

  it("preserves unknown clean unshipped commits rather than publishing them as routine maintenance", async () => {
    const f = await publishedTask();
    fs.writeFileSync(path.join(f.worktree, "unfinished.txt"), "retain me\n");
    git(f.worktree, "add", ".");
    git(f.worktree, "commit", "-m", "unfinished local work");
    const unshipped = git(f.worktree, "rev-parse", "HEAD");
    expect(await maintainOutdatedPr(f.options)).toBe("blocked");
    expect(git(f.worktree, "rev-parse", "HEAD")).toBe(unshipped);
    expect(git(f.source, "ls-remote", "origin", "refs/heads/agent/card")).toContain(f.published);
  });

  it("honors human closure during conflict assistance without pushing or resurrecting its branch", async () => {
    const f = await publishedTask(true);
    const push = vi.spyOn(f.options.git, "push");
    f.options.remediateConflict = async () => {
      fs.writeFileSync(path.join(f.worktree, "base.txt"), "unshipped resolution\n");
      f.terminal();
      git(f.source, "push", "origin", "--delete", "agent/card");
    };
    expect(await maintainOutdatedPr(f.options)).toBe("terminal");
    expect(push).not.toHaveBeenCalled();
    expect(await f.github.getPullRequestDescription()).not.toContain("Agent Orchestrator status:");
    expect(git(f.source, "ls-remote", "origin", "refs/heads/agent/card")).toBe("");
    expect(fs.readFileSync(path.join(f.worktree, "base.txt"), "utf8")).toBe(
      "unshipped resolution\n",
    );
  });
});

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
          throw new Error("simulated acknowledgement loss after remote acceptance");
        }
        return output.trim();
      }
      return git(cwd, ...args);
    });

    await expect(client.push(repo, "origin", "agent/card-1")).rejects.toThrow(
      "simulated acknowledgement loss",
    );
    expect(await client.getRemoteBranchSha(repo, "origin", "agent/card-1")).toBe(taskHead);
    // An authoritative exact-head read reconciles the accepted effect; do not
    // dispatch the uncertain push a second time.
    expect(pushCalls).toHaveLength(1);
    expect(git(repo, "ls-remote", "origin", "refs/heads/agent/card-1")).toContain(taskHead);
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

    expect(git(repo, "ls-remote", "origin", "refs/heads/agent/card-1")).toBe("");
    expect(git(repo, "show-ref")).toBe(taskRefsBefore);
    expect(git(repo, "count-objects", "-v")).toBe(objectsBefore);
    expect(git(task, "rev-parse", "HEAD")).toBe(historicalHead);
    expect(git(unrelated, "rev-parse", "HEAD")).toBe(unrelatedHead);
    expect(git(task, "status", "--porcelain=v1")).toContain("dirty.txt");
    expect(history.flat().join(" ")).not.toMatch(/(?:rebase|reset|clean|--force)/);
  });
});
