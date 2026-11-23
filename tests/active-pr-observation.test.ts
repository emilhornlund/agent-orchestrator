import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import type { GitHubClient } from "../src/github/github-client.js";
import { RunStore } from "../src/task-session/run-store.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import { readTerminalPrFence } from "../src/task-session/terminal-pr-fence.js";
import {
  observeActivePullRequest,
  readActivePrArrivals,
  readActivePrObservationHealth,
  withActivePrObservation,
} from "../src/orchestrator/active-pr-observation.js";

let root: string;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  vi.useRealTimers();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-observation-"));
  const project = {
    id: "project",
    contextRoot: path.join(root, "state"),
    repository: {
      path: path.join(root, "repo"),
      worktreeRoot: path.join(root, "worktrees"),
      github: "owner/repo",
      defaultBranch: "main",
    },
  } as ProjectConfig & { contextRoot: string };
  const pinned = {
    integrationId: "integration",
    projectId: project.id,
    boardId: "board",
    lists: {
      ready: "ready",
      working: "working",
      review: "review",
      failed: "failed",
      done: "done",
      backlog: "backlog",
    },
    repository: project.repository.github,
    repositoryPath: project.repository.path,
    worktreeRoot: project.repository.worktreeRoot,
    storageRoot: project.contextRoot,
  };
  const store = new RunStore(project.contextRoot, "attempt", pinned, {
    integrationId: pinned.integrationId,
    instanceId: "instance",
    token: "token",
    assertHeld: () => undefined,
  });
  store.create({
    version: 1,
    revision: 1,
    projectId: project.id,
    cardId: "card",
    attemptId: "attempt",
    taskKind: "implementation",
    pinned,
    lifecycle: "ci",
    checkpoint: "ci",
    publicationState: "open",
    operation: { id: null, kind: null, generation: 0 },
    wait: { reason: null, dependency: null, since: null, retryAt: null },
    owner: { instanceId: "instance", token: "token", generation: 1 },
    resources: [],
    pendingOperations: [],
    queue: [],
    budgets: {},
    sessions: {},
    artifacts: [],
    expectedTrelloListId: "review",
    terminalSync: "not-applicable",
    terminalEvidence: null,
    legacy: {},
    compatibility: {},
    updatedAt: new Date().toISOString(),
  });
  const authority = new ProjectRunAuthority(project.id, store, 1, undefined, undefined, "card");
  const tasks = new TaskExecutionStore(project.contextRoot, project, authority);
  const headSha = "a".repeat(40);
  const pr = {
    url: "https://github.com/owner/repo/pull/1",
    state: "OPEN" as const,
    mergedAt: null,
    headRefOid: headSha,
    headRefName: "agent/card",
    baseRefName: "main",
    headRepository: { name: "repo" },
    headRepositoryOwner: { login: "owner" },
  };
  tasks.create({
    version: 1,
    revision: 1,
    projectId: project.id,
    cardId: "card",
    phase: "ci",
    expectedBranch: "agent/card",
    primarySessionId: "ses_primary",
    sessionCreationStatus: "bound",
    pullRequest: { number: 1, url: pr.url, headSha },
    operationKey: "operation",
    retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  let body = "first request";
  const github = {
    comparePullRequestHeadToBase: vi.fn(async () => "current" as const),
    findPullRequestState: vi.fn(async () => pr),
    findChangesRequestedPullRequest: vi.fn(async () => null),
    getPullRequestConversationComments: vi.fn(async () => [
      {
        id: 1,
        author: "human",
        body,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: null,
      },
    ]),
    getCiObservations: vi.fn(async () => ({
      headSha,
      checks: [],
      expectationSources: [],
    })),
  } as unknown as GitHubClient;
  return {
    project,
    store,
    authority,
    tasks,
    github,
    pr,
    edit: (text: string) => {
      body = text;
    },
  };
}

it("retains deduplicated arrivals during a blocked writer without changing its checkpoint, including restart", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const before = f.tasks.read("card");
  let finish!: () => void;
  const writer = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const errors = vi.fn();
  const running = withActivePrObservation(
    {
      ...f,
      intervalMs: 100,
      signal: new AbortController().signal,
      onError: errors,
    },
    () => writer,
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(readActivePrArrivals(f.authority)).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(readActivePrArrivals(f.authority)).toHaveLength(1);
  f.edit("new request during execution");
  await vi.advanceTimersByTimeAsync(100);
  expect(readActivePrArrivals(f.authority)).toHaveLength(2);
  const queue = new TaskMutationQueue(f.project.contextRoot, f.project, f.authority);
  expect(queue.list()).toMatchObject([
    { kind: "feedback", status: "queued", dispatchReady: false },
    { kind: "feedback", status: "queued", dispatchReady: false },
  ]);
  expect(queue.claimNext()).toBeNull();
  expect(f.tasks.read("card")).toEqual(before);
  const restarted = new ProjectRunAuthority(f.project.id, f.store, 1, undefined, undefined, "card");
  expect(readActivePrArrivals(restarted)).toEqual(readActivePrArrivals(f.authority));
  finish();
  await running;
  expect(vi.getTimerCount()).toBe(0);
  expect(errors).not.toHaveBeenCalled();
});

it("deduplicates a previously retired feedback observation without reviving it or blocking later reads", async () => {
  const f = fixture();
  await observeActivePullRequest(f);
  const queue = new TaskMutationQueue(f.project.contextRoot, f.project, f.authority);
  const event = queue.list()[0]!;
  queue.retireSupersededObservation(event.eventId);
  await expect(observeActivePullRequest(f)).resolves.toBeUndefined();
  expect(queue.get(event.eventId)?.status).toBe("retired");
  expect(readActivePrArrivals(f.authority)).toHaveLength(1);
  f.edit("A genuinely new request");
  await observeActivePullRequest(f);
  expect(readActivePrArrivals(f.authority)).toHaveLength(2);
  expect(queue.list().filter((item) => item.status === "queued")).toHaveLength(1);
});

it("retains observer failure diagnostics without interrupting the writer and backs off rechecks", async () => {
  vi.useFakeTimers();
  const f = fixture();
  vi.mocked(f.github.findPullRequestState).mockRejectedValue(new Error("observation unavailable"));
  const errors = vi.fn();
  let finish!: () => void;
  const writer = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const running = withActivePrObservation(
    { ...f, intervalMs: 100, signal: new AbortController().signal, onError: errors },
    () => writer,
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(errors).toHaveBeenCalledOnce();
  const reference = errors.mock.calls[0]![1] as string;
  expect(JSON.parse(f.store.readArtifact(reference).toString("utf8"))).toEqual({
    kind: "active-pr-observation-failure",
    name: "Error",
    message: "observation unavailable",
  });
  await vi.advanceTimersByTimeAsync(199);
  expect(errors).toHaveBeenCalledOnce();
  finish();
  await running;
  expect(vi.getTimerCount()).toBe(0);
});

it("persists degraded health across restart and requires a complete recovery observation", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const lookup = vi.mocked(f.github.findPullRequestState);
  lookup.mockRejectedValue(new Error("provider not responding"));
  const onError = vi.fn();
  const options = { ...f, intervalMs: 100, signal: new AbortController().signal, onError };
  const first = deferred<string>();
  const running = withActivePrObservation(options, () => first.promise);
  await vi.advanceTimersByTimeAsync(300);
  expect(lookup).toHaveBeenCalledTimes(2);
  expect(onError).toHaveBeenCalledOnce();
  first.resolve("writer succeeded");
  await expect(running).resolves.toBe("writer succeeded");
  const authority = new ProjectRunAuthority(f.project.id, f.store, 1, undefined, undefined, "card");
  expect(readActivePrObservationHealth(authority)).toMatchObject({
    status: "degraded",
    failures: 2,
  });
  lookup.mockResolvedValue(f.pr);
  const complete = vi.mocked(f.github.getCiObservations);
  complete.mockResolvedValueOnce({ headSha: "b".repeat(40), checks: [], expectationSources: [] });
  const second = deferred<void>();
  const resumed = withActivePrObservation({ ...options, authority }, () => second.promise);
  await vi.advanceTimersByTimeAsync(399);
  expect(lookup).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(readActivePrObservationHealth(authority)).toMatchObject({
    status: "degraded",
    failures: 3,
  });
  expect(readActivePrArrivals(authority)).toEqual([]);
  await vi.advanceTimersByTimeAsync(800);
  expect(readActivePrObservationHealth(authority)).toMatchObject({
    status: "healthy",
    failures: 0,
  });
  expect(readActivePrArrivals(authority)).toHaveLength(1);
  second.resolve();
  await resumed;
});

it("times out a delayed observer without overlapping it or invalidating the writer", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const late = deferred<Awaited<ReturnType<GitHubClient["findPullRequestState"]>>>();
  const lookup = vi.mocked(f.github.findPullRequestState).mockReturnValueOnce(late.promise);
  const writer = deferred<number>();
  const onError = vi.fn();
  const result = withActivePrObservation(
    { ...f, intervalMs: 100, timeoutMs: 50, signal: new AbortController().signal, onError },
    () => writer.promise,
  );
  await vi.advanceTimersByTimeAsync(400);
  expect(lookup).toHaveBeenCalledOnce();
  expect(onError).toHaveBeenCalledOnce();
  expect(readActivePrObservationHealth(f.authority)).toMatchObject({ identity: "timeout" });
  writer.resolve(42);
  await expect(result).resolves.toBe(42);
  late.resolve(f.pr);
  await vi.advanceTimersByTimeAsync(1);
  expect(readActivePrArrivals(f.authority)).toEqual([]);
});

it("preserves prior arrivals on outages and rejects stale owner generations", async () => {
  const f = fixture();
  await observeActivePullRequest(f);
  vi.mocked(f.github.findPullRequestState).mockRejectedValueOnce(new Error("outage"));
  await expect(observeActivePullRequest(f)).rejects.toThrow("outage");
  expect(readActivePrArrivals(f.authority)).toHaveLength(1);
  const stale = new ProjectRunAuthority(f.project.id, f.store, 2, undefined, undefined, "card");
  await expect(observeActivePullRequest({ ...f, authority: stale })).rejects.toThrow();
  expect(readActivePrArrivals(f.authority)).toHaveLength(1);
});

it("queues a known CI failure once even when another expected check never finishes", async () => {
  const f = fixture();
  vi.mocked(f.github.getPullRequestConversationComments).mockResolvedValue([]);
  vi.mocked(f.github.getCiObservations).mockResolvedValue({
    headSha: f.pr.headRefOid,
    expectationSources: [
      { kind: "workflow-contract", sourceId: "ci", complete: true, checkNames: ["Build", "Tests"] },
    ],
    checks: [
      {
        source: "check-run",
        id: 1,
        name: "Build",
        status: "completed",
        conclusion: "failure",
        headSha: f.pr.headRefOid,
        url: null,
      },
      {
        source: "check-run",
        id: 2,
        name: "Tests",
        status: "queued",
        conclusion: null,
        headSha: f.pr.headRefOid,
        url: null,
      },
    ],
  });
  await observeActivePullRequest(f);
  const restarted = new ProjectRunAuthority(f.project.id, f.store, 1, undefined, undefined, "card");
  await observeActivePullRequest({ ...f, authority: restarted });
  const queue = new TaskMutationQueue(f.project.contextRoot, f.project, restarted);
  expect(queue.list()).toMatchObject([{ kind: "ci-repair", status: "queued" }]);
  expect(queue.claimNext()?.kind).toBe("ci-repair");
});

it("does not persist mixed feedback when the PR changes during observation", async () => {
  const f = fixture();
  vi.mocked(f.github.findPullRequestState)
    .mockResolvedValueOnce(f.pr as Awaited<ReturnType<GitHubClient["findPullRequestState"]>>)
    .mockResolvedValueOnce({ ...f.pr, state: "CLOSED" } as Awaited<
      ReturnType<GitHubClient["findPullRequestState"]>
    >);
  await observeActivePullRequest(f);
  expect(readActivePrArrivals(f.authority)).toMatchObject([{ state: "CLOSED" }]);
  expect(readTerminalPrFence(f.authority)).toMatchObject({ state: "CLOSED" });
  expect(new TaskMutationQueue(f.project.contextRoot, f.project, f.authority).list()).toMatchObject(
    [{ kind: "terminal-pr" }],
  );
});

it("reconciles interruption between durable observation and queue descriptor without losing or duplicating the arrival", async () => {
  const f = fixture();
  const interrupted = vi
    .spyOn(TaskMutationQueue.prototype, "enqueue")
    .mockImplementationOnce(() => {
      throw new Error("descriptor write interrupted");
    });
  await expect(observeActivePullRequest(f)).rejects.toThrow("descriptor write interrupted");
  interrupted.mockRestore();
  expect(readActivePrArrivals(f.authority)).toHaveLength(1);
  await observeActivePullRequest(f);
  await observeActivePullRequest(f);
  const queue = new TaskMutationQueue(f.project.contextRoot, f.project, f.authority);
  expect(queue.list()).toHaveLength(1);
  expect(queue.list()[0]?.dispatchReady).toBe(false);
  expect(readActivePrArrivals(f.authority)).toHaveLength(1);
});
