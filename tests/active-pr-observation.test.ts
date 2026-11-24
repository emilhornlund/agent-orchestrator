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
import { feedbackClassificationCheckpoint } from "../src/task-session/feedback-classification-checkpoint.js";
import { FeedbackClassificationError } from "../src/task-session/classify-current-feedback.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { actionableFeedbackResponse } from "./support/feedback-classification-response.js";
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
  const readPr = vi.fn(async () => pr);
  const github = {
    comparePullRequestHeadToBase: vi.fn(async () => "current" as const),
    findPullRequestState: readPr,
    getPullRequestStateByNumber: readPr,
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
    getPullRequestCommitShas: vi.fn(async () => [headSha]),
    isAncestorCommit: vi.fn(async () => true),
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

it("defers a verified external open-PR fast-forward without moving the owned checkpoint", async () => {
  const f = fixture();
  const nextHead = "b".repeat(40);
  const before = f.tasks.read("card");
  vi.mocked(f.github.getPullRequestStateByNumber).mockResolvedValue({
    ...f.pr,
    headRefOid: nextHead,
  });
  vi.mocked(f.github.getPullRequestCommitShas).mockResolvedValue([f.pr.headRefOid, nextHead]);

  await expect(observeActivePullRequest(f)).resolves.toBe("external-head");
  expect(f.tasks.read("card")).toEqual(before);
  expect(readActivePrArrivals(f.authority)).toEqual([]);
  expect(new TaskMutationQueue(f.project.contextRoot, f.project, f.authority).list()).toEqual([]);
  expect(f.github.getCiObservations).not.toHaveBeenCalled();
});

it("rejects an unverified external head rewrite without accepting it as task output", async () => {
  const f = fixture();
  const nextHead = "b".repeat(40);
  vi.mocked(f.github.getPullRequestStateByNumber).mockResolvedValue({
    ...f.pr,
    headRefOid: nextHead,
  });
  vi.mocked(f.github.getPullRequestCommitShas).mockResolvedValue([f.pr.headRefOid, nextHead]);
  vi.mocked(f.github.isAncestorCommit).mockResolvedValue(false);

  await expect(observeActivePullRequest(f)).rejects.toThrow("not descended");
  expect(readActivePrArrivals(f.authority)).toEqual([]);
});

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
    status: "recovering",
    failures: 3,
    consecutiveSuccesses: 1,
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(readActivePrObservationHealth(authority)).toMatchObject({
    status: "healthy",
    failures: 0,
  });
  expect(readActivePrArrivals(authority)).toHaveLength(1);
  second.resolve();
  await resumed;
});

it("keeps fresh feedback independent of a nearly exhausted revision after restart", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const f = fixture();
  const use = () =>
    feedbackClassificationCheckpoint({
      project: f.project,
      cardId: "card",
      pullRequestUrl: f.pr.url,
      worktreePath: "/owned/worktree",
    })!;
  const fail = async (authority: ProjectRunAuthority, revision: string) =>
    authority.run(async () => {
      const episode = use();
      episode.reserve([revision]);
      await episode.fail(new FeedbackClassificationError("nonzero"));
      vi.setSystemTime(Date.now() + 60_000);
    });
  await fail(f.authority, "request-a:revision-1");
  await fail(f.authority, "request-a:revision-1");
  const restarted = new ProjectRunAuthority(f.project.id, f.store, 1, undefined, undefined, "card");
  const a = "request-a:revision-1";
  const b = "request-b:revision-1";
  expect(restarted.run(() => use().selectRevisions([a, b]))).toEqual([b]);
  await fail(restarted, b);
  await fail(restarted, a);
  expect(restarted.run(() => use().selectRevisions([a, b]))).toEqual([b]);
  expect(restarted.run(() => use().selectRevisions([a, "request-a:revision-2"]))).toEqual([
    "request-a:revision-2",
  ]);
});

it("does not exhaust feedback after repeatedly restarting before the classifier can launch", async () => {
  const f = fixture();
  const revision = "request:revision-1";
  for (let n = 0; n < 4; n++) {
    const owner = new ProjectRunAuthority(f.project.id, f.store, 1, undefined, undefined, "card");
    owner.run(() => {
      const checkpoint = feedbackClassificationCheckpoint({
        project: f.project,
        cardId: "card",
        pullRequestUrl: f.pr.url,
        worktreePath: "/owned/worktree",
      })!;
      checkpoint.assertStopped();
      expect(checkpoint.selectRevisions([revision])).toEqual([revision]);
      checkpoint.reserve([revision]);
      // Interrupt before the onExecutionPrepared callback can bind the child.
    });
  }
});

it("archives a completed classification after a crash between ledger commit and checkpoint cleanup", () => {
  const f = fixture();
  const use = () =>
    feedbackClassificationCheckpoint({
      project: f.project,
      cardId: "card",
      pullRequestUrl: f.pr.url,
      worktreePath: "/owned/worktree",
    })!;
  f.authority.run(() => {
    const episode = use();
    episode.reserve(["request:revision"]);
    episode.prepareLedgerCommit(4);
  });
  const restarted = new ProjectRunAuthority(f.project.id, f.store, 1, undefined, undefined, "card");
  const state = () =>
    f.store.read()!.compatibility["feedback-classification-v1"] as {
      active: object;
      archiveHead: string | null;
    };
  restarted.run(() => use().finishCommittedCheckpoints(3));
  expect(Object.values(state().active)).toHaveLength(1);
  for (let revision = 4; revision < 40; revision++) {
    restarted.run(() => {
      use().finishCommittedCheckpoints(revision);
      expect(state().active).toEqual({});
      const next = use();
      next.reserve([`request:${revision}`]);
      next.prepareLedgerCommit(revision + 1);
    });
  }
  expect(Object.values(state().active)).toHaveLength(1);
  expect(state().archiveHead).toMatch(/^sha256:/u);
});

it.each(["configuration", "malformed"] as const)(
  "reopens an original %s block only after a paced dependency probe",
  async (failure) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture();
    const project: ProjectConfig = {
      ...f.project,
      opencode: {
        refinement: {},
        implementation: {},
        review: { model: "fixture" },
        remediation: { maxPasses: 1 },
        commit: {},
        timeoutMinutes: 1,
      },
    };
    const email = { send: vi.fn(async () => undefined) };
    const revision = "review:42:original-revision";
    const use = () =>
      feedbackClassificationCheckpoint({
        project,
        cardId: "card",
        pullRequestUrl: f.pr.url,
        worktreePath: "/owned/worktree",
        emailNotifier: email,
      })!;
    let ready = false;
    const probe = vi.fn(async ({ prompt }: { prompt: string }) => ({
      exitCode: ready ? 0 : 1,
      output: ready
        ? actionableFeedbackResponse(prompt).replaceAll('"actionable"', '"discussion"')
        : "",
      errorOutput: "",
    }));
    const openCode = new OpenCodeClient(probe);
    const signal = new AbortController().signal;
    for (let i = 0; i < (failure === "configuration" ? 1 : 3); i++) {
      await f.authority.run(async () => {
        const episode = use();
        episode.reserve([revision]);
        await episode.fail(new FeedbackClassificationError(failure));
      });
      vi.setSystemTime(Date.now() + 60_000);
    }
    const reopen = () =>
      new ProjectRunAuthority(project.id, f.store, 1, undefined, undefined, "card");
    let owner = reopen();
    const before = f.store.read()!.revision;
    for (let i = 0; i < 1_000; i++) {
      expect(
        await owner.run(() => use().selectWithRecovery([revision], openCode, signal)),
      ).toMatchObject({ status: "blocked", retryAt: expect.any(String) });
    }
    expect(f.store.read()!.revision).toBe(before);
    expect(probe).not.toHaveBeenCalled();
    expect(email.send).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 5 * 60_000);
    await owner.run(() => use().selectWithRecovery([revision], openCode, signal));
    expect(probe).toHaveBeenCalledOnce();
    ready = true;
    owner = reopen();
    vi.setSystemTime(Date.now() + 10 * 60_000);
    expect(await owner.run(() => use().selectWithRecovery([revision], openCode, signal))).toEqual([
      revision,
    ]);
    owner.run(() => {
      const episode = use();
      episode.reserve([revision]);
      episode.complete();
    });
    const state = f.store.read()!.compatibility["feedback-classification-v1"] as {
      active: object;
      archiveHead: string;
    };
    expect(state.active).toEqual({});
    expect(JSON.parse(f.store.readArtifact(state.archiveHead).toString("utf8"))).toMatchObject({
      kind: "feedback-classification-history",
      previous: expect.stringMatching(/^sha256:/u),
      entries: [{ status: "recovered", revisions: [revision] }],
    });
    expect(email.send).toHaveBeenCalledTimes(1);
  },
);

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
  const diagnosticRef = onError.mock.calls[0]![1] as string;
  expect(JSON.parse(f.store.readArtifact(diagnosticRef).toString("utf8"))).toMatchObject({
    message: expect.stringContaining("pending: PR identity"),
  });
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
