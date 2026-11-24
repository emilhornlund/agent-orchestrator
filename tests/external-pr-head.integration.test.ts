import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { reconcileExternalOpenPrHead } from "../src/orchestrator/reconcile-external-open-pr-head.js";
import { pollProject } from "../src/orchestrator/poll-project.js";
import { hasDueTaskSessionRecoveryWait } from "../src/orchestrator/run-orchestrator.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { CommandRunner } from "../src/process/command-runner.js";
import { actionableFeedbackResponse } from "./support/feedback-classification-response.js";
import {
  readTrustedCommitState,
  writeTrustedCommitState,
} from "../src/orchestrator/trusted-commit-state.js";
import { readTerminalPrFence } from "../src/task-session/terminal-pr-fence.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { transitionTaskExecutionRecord } from "../src/task-session/task-execution-transition.js";
import { FeedbackLedgerStore } from "../src/task-session/feedback-ledger-store.js";
import { PrMaintenanceStore } from "../src/task-session/pr-maintenance-store.js";
import {
  createPublicationFixture,
  reopenPublicationFixture,
} from "./support/initial-publication-fixture.js";

let root: string;
afterEach(() => {
  vi.restoreAllMocks();
  if (root) fs.rmSync(root, { force: true, recursive: true });
});

function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-pr-head-"));
  const f = createPublicationFixture(root);
  const { project, worktreePath, isolated } = f;
  const { git } = isolated;
  const remote = path.join(root, "remote.git");
  const reviewer = path.join(root, "reviewer");
  const branch = "agent/card";
  git(worktreePath, "add", ".");
  git(worktreePath, "commit", "-m", "Published implementation");
  git(worktreePath, "push", remote, branch);
  const published = git(worktreePath, "rev-parse", "HEAD");
  git(root, "clone", "-b", "main", remote, reviewer);
  const pr = {
    url: "https://github.com/owner/repo/pull/1",
    title: "Task",
    body: "Description",
    draft: false,
    head: published,
  };
  f.services.change({ list: "review", prs: [pr], requests: [pr] });
  const options = (runtime = f as ReturnType<typeof reopenPublicationFixture>) => ({
    project: runtime.project,
    card: runtime.services.card(),
    git: runtime.git,
    github: runtime.services.github,
    taskStore: new TaskExecutionStore(project.contextRoot, project, runtime.authority),
    queue: new TaskMutationQueue(project.contextRoot, project, runtime.authority),
    maintenanceStore: new PrMaintenanceStore(project.contextRoot, project, runtime.authority),
    feedbackLedgerStore: new FeedbackLedgerStore(project.contextRoot, project, runtime.authority),
    signal: new AbortController().signal,
  });
  const o = options();
  f.authority.run(() => {
    const task = o.taskStore.read("card")!;
    const timestamp = new Date(Date.parse(task.updatedAt) + 1).toISOString();
    const next = transitionTaskExecutionRecord(task, {
      type: "publication-completed",
      eventId: "original-pr",
      projectId: project.id,
      cardId: "card",
      operationKey: task.operationKey,
      occurredAt: timestamp,
      pullRequest: { number: 1, url: pr.url, headSha: published },
    });
    const id = `sha256:${"a".repeat(64)}`;
    o.taskStore.compareAndSwap("card", task.revision, {
      ...next,
      publicationQuality: {
        contentIdentity: id,
        validation: {
          command: "true",
          startedAt: timestamp,
          completedAt: timestamp,
          exitCode: 0,
          contentIdentity: id,
          diagnostic: "",
          status: "passed",
        },
        review: { verdict: "pass", reviewedContentIdentity: id },
      },
      ciObservationWindow: {
        headSha: published,
        startedAt: timestamp,
        deadline: timestamp,
        timedOut: true,
      },
      reviewObservation: {
        headSha: published,
        observedAt: timestamp,
        ciEvaluation: {
          status: "failed",
          expectedCheckNames: ["Build"],
          missingChecks: [],
          pendingChecks: [],
          failureCheckNames: ["Build"],
        },
        feedbackIds: [],
      },
      ciRepair: {
        headSha: published,
        cycleId: "original-ci",
        status: "stopped",
        stopReason: "no-change",
      },
    });
    o.queue.claimForRecovery("implementation:card");
    o.queue.complete("implementation:card");
    writeTrustedCommitState(project, "card", {
      version: 1,
      kind: "trusted-commit",
      cardId: "card",
      projectId: project.id,
      taskBranch: branch,
      defaultBranch: "main",
      commitSha: published,
    });
  });
  const processDirectory = path.join(
    o.taskStore.processExecutionDirectory("card")!,
    "process-executions",
    "old-execution",
  );
  fs.mkdirSync(processDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(processDirectory, "execution.json"),
    JSON.stringify({ executionId: "old-execution", status: "success", treeStopped: true }),
  );
  function setupGithub(runtime: ReturnType<typeof reopenPublicationFixture>) {
    runtime.services.github.isAncestorCommit = vi.fn(async ({ ancestorSha, descendantSha }) => {
      try {
        git(reviewer, "merge-base", "--is-ancestor", ancestorSha, descendantSha);
        return true;
      } catch {
        return false;
      }
    });
  }
  setupGithub(f);
  function restart() {
    const runtime = reopenPublicationFixture(root, `lease-${Date.now()}-${Math.random()}`);
    setupGithub(runtime);
    return runtime;
  }
  function reconcile(runtime = f as ReturnType<typeof reopenPublicationFixture>) {
    return runtime.authority.run(() => reconcileExternalOpenPrHead(options(runtime)));
  }
  let changes = 0;
  function advance(mode: "merge" | "fast-forward" | "diverge" = "fast-forward") {
    if (mode === "merge" || mode === "diverge") {
      git(reviewer, "switch", "main");
      fs.writeFileSync(path.join(reviewer, "base-update.txt"), "Default branch update\n");
      git(reviewer, "add", ".");
      git(reviewer, "commit", "-m", "Default branch advanced");
      git(reviewer, "push", "origin", "main");
    }
    if (mode !== "diverge") {
      if (!changes) git(reviewer, "switch", "-c", branch, `origin/${branch}`);
      else git(reviewer, "switch", branch);
      if (mode === "merge")
        git(reviewer, "merge", "--no-ff", "main", "-m", "Merge main into agent branch");
      else {
        fs.writeFileSync(path.join(reviewer, "reviewer.txt"), `Reviewer update ${++changes}\n`);
        git(reviewer, "add", ".");
        git(reviewer, "commit", "-m", "Reviewer update");
      }
    }
    git(
      reviewer,
      "push",
      ...(mode === "diverge" ? ["--force"] : []),
      "origin",
      `HEAD:refs/heads/${branch}`,
    );
    const target = git(reviewer, "rev-parse", "HEAD");
    f.services.change({ prs: [{ ...pr, head: target }] });
    return target;
  }
  const localHead = () => git(worktreePath, "rev-parse", "HEAD");
  return { ...f, o, options, reconcile, advance, localHead, published, restart, branch };
}

it.each(["fast-forward", "merge"] as const)(
  "polls an existing published task after restart and adopts a real external %s",
  async (mode) => {
    const f = fixture();
    const target = f.advance(mode);
    const restarted = f.restart();
    const effects = f.services.entries().filter(({ type }) => type.endsWith("request"));
    const noAi = vi.fn(() => {
      throw new Error("Adoption must not dispatch implementation");
    });
    const commands = new CommandRunner(async () => ({
      exitCode: 0,
      output: JSON.stringify([{ id: "primary", directory: f.worktreePath }]),
      errorOutput: "",
    }));
    const ci = vi.spyOn(restarted.services.github, "getCiObservations");
    const poll = (opencode = new OpenCodeClient(noAi)) =>
      pollProject(
        restarted.services.trello,
        restarted.git,
        restarted.services.github,
        opencode,
        commands,
        restarted.project,
        new AbortController().signal,
        undefined,
        undefined,
        undefined,
        restarted.authority,
      );
    await poll();
    const { taskStore, queue } = f.options(restarted);
    expect(f.localHead()).toBe(target);
    expect(
      restarted.authority.run(() => readTrustedCommitState(restarted.project, "card")?.commitSha),
    ).toBe(target);
    const task = taskStore.read("card")!;
    expect(task.pullRequest).toEqual({
      number: 1,
      url: "https://github.com/owner/repo/pull/1",
      headSha: target,
    });
    expect(task.primarySessionId).toBe("primary");
    expect(task.publicationQuality).toBeUndefined();
    expect(task.ciObservationWindow).toBeUndefined();
    expect(task.reviewObservation).toBeUndefined();
    expect(task.ciRepair).toBeUndefined();
    expect(
      taskStore.readSetupArtifact(task.externalHeadAdoption!.previousState.reference),
    ).toMatchObject({
      task: {
        publicationQuality: { validation: { status: "passed" } },
        pullRequest: { headSha: f.published },
      },
    });
    expect(queue.list().filter((event) => event.kind === "external-pr-head")).toMatchObject([
      { status: "completed" },
    ]);
    expect(f.services.entries().filter(({ type }) => type.endsWith("request"))).toEqual(effects);
    expect(noAi).not.toHaveBeenCalled();
    const fastForward = vi.spyOn(restarted.git, "fastForwardTaskWorktree");
    await poll();
    expect(ci).toHaveBeenCalledWith(expect.objectContaining({ headSha: target }));
    expect(taskStore.read("card")?.reviewObservation?.headSha).toBe(target);
    expect(taskStore.read("card")?.ciObservationWindow?.headSha).toBe(target);
    expect(fastForward).not.toHaveBeenCalled();
    expect(noAi).not.toHaveBeenCalled();
  },
);

it("classifies an outstanding requested-change review against the adopted head", async () => {
  const f = fixture();
  const target = f.advance("merge");
  const runtime = f.restart();
  runtime.project.opencode.review = { model: "test/review", variant: "default" };
  const dispatchDraft = vi.fn(async () => {
    throw new Error("simulated outage at correction dispatch");
  });
  runtime.services.github.ensurePullRequestDraft = dispatchDraft;
  vi.spyOn(runtime.services.github, "findChangesRequestedPullRequest").mockResolvedValue({
    url: "https://github.com/owner/repo/pull/1",
    headSha: target,
    feedback: {
      reviews: [
        {
          id: 11,
          body: "Please add a regression test.",
          author: "reviewer",
          submittedAt: new Date().toISOString(),
          commitSha: f.published,
          inlineComments: [],
        },
      ],
    },
  });
  const classify = vi.fn(async ({ prompt }: { prompt: string }) => ({
    exitCode: 0,
    output: actionableFeedbackResponse(prompt),
    errorOutput: "",
  }));
  const openCode = new OpenCodeClient(async (op) => {
    if (op.sessionLabel !== "Human feedback classification")
      throw new Error("Unexpected writer without a planned session");
    expect(f.localHead()).toBe(target);
    return classify(op);
  });
  const commands = new CommandRunner(async () => ({
    exitCode: 0,
    output: JSON.stringify([{ id: "primary", directory: f.worktreePath }]),
    errorOutput: "",
  }));
  const poll = () =>
    pollProject(
      runtime.services.trello,
      runtime.git,
      runtime.services.github,
      openCode,
      commands,
      runtime.project,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      runtime.authority,
    );
  await poll();
  await expect(poll()).rejects.toThrow("simulated outage at correction dispatch");
  expect(dispatchDraft).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ pullRequestUrl: "https://github.com/owner/repo/pull/1" }),
  );
  expect(classify).toHaveBeenCalledOnce();
  expect(f.options(runtime).feedbackLedgerStore.read("card")?.entries).toMatchObject([
    { id: "11", actionability: "actionable" },
  ]);
  expect(f.options(runtime).queue.list()).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "feedback" })]),
  );
  expect(f.services.read().requests).toHaveLength(1);
});

it("recovers the legacy idle PR identity/head attention checkpoint without a new task", async () => {
  const f = fixture();
  const target = f.advance();
  const task = f.o.taskStore.read("card")!;
  f.authority.run(() =>
    f.o.taskStore.compareAndSwap("card", task.revision, {
      ...transitionTaskExecutionRecord(task, {
        type: "attention-required",
        eventId: "legacy-head-mismatch",
        projectId: f.project.id,
        cardId: task.cardId,
        operationKey: task.operationKey,
        occurredAt: new Date(Date.parse(task.updatedAt) + 1).toISOString(),
      }),
      recoveryAttentionReason:
        "Persisted and authoritative pull request identity/head are ambiguous",
    }),
  );
  const runtime = f.restart();
  expect(hasDueTaskSessionRecoveryWait(runtime.store.read())).toBe(true);
  await f.reconcile(runtime);
  expect(f.options(runtime).taskStore.read("card")).toMatchObject({
    phase: "ci",
    pullRequest: { headSha: target },
  });
  expect(runtime.store.read()).toMatchObject({ lifecycle: "ci", publicationState: "open" });
});

it("does not fast-forward through a hidden local index entry", async () => {
  const f = fixture();
  f.advance();
  f.isolated.git(f.worktreePath, "update-index", "--assume-unchanged", "source.txt");
  fs.writeFileSync(path.join(f.worktreePath, "source.txt"), "Hidden unshipped edit\n");
  await expect(f.reconcile()).rejects.toThrow("hidden index");
  expect(fs.readFileSync(path.join(f.worktreePath, "source.txt"), "utf8")).toBe(
    "Hidden unshipped edit\n",
  );
  expect(f.localHead()).toBe(f.published);
});

it.each(["intent", "local update", "publication CAS"] as const)(
  "recovers interruption at %s without replaying the branch update",
  async (boundary) => {
    const f = fixture();
    const target = f.advance();
    if (boundary === "intent")
      vi.spyOn(f.git, "fastForwardTaskWorktree").mockRejectedValueOnce(new Error("interrupt"));
    if (boundary === "local update") {
      const fastForward = f.git.fastForwardTaskWorktree.bind(f.git);
      vi.spyOn(f.git, "fastForwardTaskWorktree").mockImplementationOnce(async (...args) => {
        await fastForward(...args);
        throw new Error("interrupt");
      });
    }
    if (boundary === "publication CAS")
      vi.spyOn(TaskMutationQueue.prototype, "complete").mockImplementationOnce(() => {
        throw new Error("interrupt");
      });
    await expect(f.reconcile()).rejects.toThrow("interrupt");
    const runtime = f.restart();
    const merge = vi.spyOn(runtime.git, "fastForwardTaskWorktree");
    await f.reconcile(runtime);
    expect(merge).toHaveBeenCalledTimes(boundary === "intent" ? 1 : 0);
    expect(f.localHead()).toBe(target);
    expect(f.options(runtime).taskStore.read("card")?.pullRequest?.headSha).toBe(target);
    expect(f.options(runtime).queue.getActive()).toBeNull();
  },
);

it("adopts a further verified advance after the head changes during local reconciliation", async () => {
  const f = fixture();
  const first = f.advance();
  const fastForward = f.git.fastForwardTaskWorktree.bind(f.git);
  let next = "";
  vi.spyOn(f.git, "fastForwardTaskWorktree").mockImplementationOnce(async (...args) => {
    await fastForward(...args);
    next = f.advance();
  });
  await expect(f.reconcile()).rejects.toThrow("Remote task branch changed");
  expect(f.localHead()).toBe(first);
  expect(f.o.taskStore.read("card")?.pullRequest?.headSha).toBe(f.published);
  const runtime = f.restart();
  await f.reconcile(runtime);
  expect(f.localHead()).toBe(next);
  expect(f.options(runtime).taskStore.read("card")?.pullRequest?.headSha).toBe(next);
});

it.each(["CLOSED", "MERGED"] as const)(
  "gives %s precedence over adoption after the local update",
  async (state) => {
    const f = fixture();
    const target = f.advance();
    const fastForward = f.git.fastForwardTaskWorktree.bind(f.git);
    const read = f.o.github.getPullRequestStateByNumber.bind(f.o.github);
    vi.spyOn(f.git, "fastForwardTaskWorktree").mockImplementationOnce(async (...args) => {
      await fastForward(...args);
      vi.spyOn(f.o.github, "getPullRequestStateByNumber").mockImplementation(async (lookup) => ({
        ...(await read(lookup)),
        state,
        mergedAt: state === "MERGED" ? new Date().toISOString() : null,
      }));
    });
    await f.reconcile();
    expect(readTerminalPrFence(f.authority)).toMatchObject({
      state,
      headSha: target,
      preserveArtifacts: true,
    });
    expect(f.o.taskStore.read("card")?.pullRequest?.headSha).toBe(f.published);
  },
);

it.each([
  "dirty",
  "unpublished",
  "divergent",
  "wrong repository",
  "active implementation",
  "active validation",
  "active remediation",
  "pending mutation",
] as const)("retains ownership and work for %s", async (kind) => {
  const f = fixture();
  f.advance(kind === "divergent" ? "diverge" : "fast-forward");
  let diagnostic: string;
  if (kind === "dirty" || kind === "unpublished") {
    fs.writeFileSync(path.join(f.worktreePath, "local.txt"), "Preserve local work\n");
    if (kind === "unpublished") {
      f.isolated.git(f.worktreePath, "add", ".");
      f.isolated.git(f.worktreePath, "commit", "-m", "Unpublished correction");
    }
    diagnostic = kind === "dirty" ? "dirty" : "unpublished";
  } else if (kind === "wrong repository") {
    const read = f.o.github.getPullRequestStateByNumber.bind(f.o.github);
    vi.spyOn(f.o.github, "getPullRequestStateByNumber").mockImplementation(async (lookup) => ({
      ...(await read(lookup)),
      headRepositoryOwner: { login: "fork" },
    }));
    diagnostic = "original PR number, repository";
  } else if (kind === "active implementation" || kind === "active remediation") {
    f.authority.run(() => {
      f.o.queue.enqueue({
        projectId: f.project.id,
        cardId: "card",
        eventId: "feedback-writer",
        operationKey: "feedback-writer",
        kind: kind === "active implementation" ? "implementation" : "feedback",
        enqueuedAt: new Date().toISOString(),
      });
      f.o.queue.claimForRecovery("feedback-writer");
    });
    diagnostic = "existing mutation owner";
  } else if (kind === "active validation") {
    const directory = path.join(
      f.o.taskStore.processExecutionDirectory("card")!,
      "process-executions",
      "validation",
    );
    fs.mkdirSync(directory);
    fs.writeFileSync(
      path.join(directory, "execution.json"),
      JSON.stringify({ executionId: "validation", status: "running", treeStopped: false }),
    );
    diagnostic = "verified process termination";
  } else if (kind === "pending mutation") {
    const artifact = f.store.writeArtifact(Buffer.from("{}"), "application/json");
    let run = f.store.read()!;
    run = f.store.referenceMutationArtifact(run.revision, run.owner.generation, artifact);
    f.store.persistMutationIntent(
      run.revision,
      run.owner.generation,
      "unfinished",
      {
        kind: "github-reply",
        target: "github:reply:1",
        correlationId: "unfinished",
        payloadId: artifact.id,
      },
      new Date().toISOString(),
    );
    diagnostic = "effects resolved";
  } else diagnostic = "does not extend";
  const before = f.localHead();
  await expect(f.reconcile()).rejects.toThrow(diagnostic);
  expect(f.localHead()).toBe(before);
  expect(f.o.taskStore.read("card")?.pullRequest?.headSha).toBe(f.published);
});
