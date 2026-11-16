import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { notificationAuthorityFixture } from "./support/notification-authority-fixture.js";
import {
  acquireProjectOwnership,
  type ProjectOwnershipLease,
} from "../src/coordination/project-ownership.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import { runTaskResources } from "../src/task-session/task-resources.js";
import { pollProject } from "../src/orchestrator/poll-project.js";
import { CommandRunner, type CommandRunOptions } from "../src/process/command-runner.js";
import { beginProcessEvidence } from "../src/process/process-runtime.js";
import {
  preparationRecoveryKey,
  preparationRecoverySchema,
} from "../src/task-session/implementation-preparation-recovery.js";
import { WorkflowMutationWaitingError } from "../src/task-session/workflow-mutation.js";
import { TrelloRequestError } from "../src/trello/trello-client.js";

const roots: string[] = [];
const leases: ProjectOwnershipLease[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const lease of leases.splice(0)) await lease.release();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "implementation-preparation-"));
  roots.push(root);
  const f = await notificationAuthorityFixture(root, "setup", undefined, true, "implementation");
  f.card.idLabels = [f.project.trello.improvementLabelId];
  f.saveCard();
  f.project.repository.setupCommand = "install dependencies";
  leases.push(f.lease);
  vi.stubGlobal("fetch", f.fetch);
  let authority = f.authority;
  let lease = f.lease;
  const realNow = Date.now.bind(Date);
  let now = realNow();
  vi.spyOn(Date, "now").mockImplementation(() => Math.max(now, realNow()));
  const state = () => authority.read(preparationRecoveryKey, preparationRecoverySchema.parse);
  const store = () => new TaskExecutionStore(f.project.contextRoot, f.project, authority);
  const task = () => store().read(f.card.id);
  const setup = vi.fn(async (options: CommandRunOptions) => {
    if (options.command !== f.project.repository.setupCommand)
      return { exitCode: 0, stdout: "[]", stderr: "" };
    const directory = store().processExecutionDirectory(f.card.id)!;
    const evidence = beginProcessEvidence(options.command, options.cwd, [], directory);
    options.onExecutionStarted?.(evidence.executionId);
    fs.writeFileSync(path.join(options.cwd, "setup-output.txt"), "preserve setup work");
    evidence.finish("success", { exitCode: 0, treeStopped: true });
    return { exitCode: 0, executionId: evidence.executionId };
  });
  const lookupPr = vi.spyOn(f.github, "findPullRequestState").mockResolvedValue(null);
  const commands = new CommandRunner(setup);
  const poll = (signal = new AbortController().signal) =>
    pollProject(
      f.trello,
      f.git,
      f.github,
      f.openCode,
      commands,
      f.project,
      signal,
      f.notifier,
      undefined,
      undefined,
      authority,
      15_000,
    );
  const due = () => {
    now = Date.parse(state()!.nextCheckAt) + 1;
  };
  const reopen = async () => {
    const priorGeneration = authority.ownerGeneration;
    await lease.release();
    lease = await acquireProjectOwnership(
      f.context.coordinationRoot,
      { trelloBoardId: f.project.trello.boardId, githubRepository: f.project.repository.github },
      "notification-authority-test",
    );
    leases.push(lease);
    authority = await ProjectRunAuthority.resumeAttempt({
      projectId: f.project.id,
      attemptId: authority.store.attemptId,
      pinned: f.pinned,
      projectLease: lease,
      coordinationRoot: f.context.coordinationRoot,
    });
    expect(authority.ownerGeneration).toBe(priorGeneration + 1);
  };
  const reachAgent = async () => {
    const controller = new AbortController();
    // End this setup-focused poll at the first real OpenCode adapter dispatch.
    // Publication consumers are exercised separately with the same large evidence.
    f.engineer.mockImplementation(async () => {
      expect(task()?.setup?.status).toBe("passed");
      controller.abort();
      return {
        exitCode: 0,
        output: JSON.stringify({ type: "step_start", sessionID: "ses_primary-test" }),
        errorOutput: "",
      };
    });
    await poll(controller.signal).catch((error: unknown) => {
      expect(controller.signal.aborted).toBe(true);
      expect(error).toMatchObject({ name: "TaskSessionImplementationWaitingError" });
    });
    expect(f.engineer).toHaveBeenCalledOnce();
  };
  return {
    ...f,
    lookupPr,
    root,
    state,
    store,
    task,
    setup,
    poll,
    due,
    reopen,
    reachAgent,
    current: () => authority,
    setupRuns: () =>
      setup.mock.calls.filter(([o]) => o.command === f.project.repository.setupCommand).length,
  };
}

const largeIgnoredInventory = () =>
  Array.from(
    { length: 110_000 },
    (_, i) => `node_modules/dependency-${i}/${"nested-package/".repeat(10)}index.js`,
  );

it.each(["fresh", "legacy-before", "legacy-after"] as const)(
  "resumes large implementation setup evidence without replay (%s)",
  async (mode) => {
    const f = await fixture();
    const ignored = largeIgnoredInventory();
    vi.spyOn(f.git, "getIgnoredFiles").mockImplementation(async () =>
      mode === "legacy-after" && f.setupRuns() === 0 ? [] : ignored,
    );
    const attempt = f.authority.store.attemptId;
    if (mode !== "fresh") {
      const write = TaskExecutionStore.prototype.writeSetupArtifact;
      const legacy = vi
        .spyOn(TaskExecutionStore.prototype, "writeSetupArtifact")
        .mockImplementation(function (this: TaskExecutionStore, id, value) {
          if (Buffer.byteLength(JSON.stringify(value)) > 16 * 1024 * 1024)
            throw new Error("Primary result exceeds 16777216-byte limit");
          return write.call(this, id, value);
        });
      await f.poll();
      expect(f.card.idList).toBe(f.project.trello.workingListId);
      expect(f.task()?.setup?.status).toBe(mode === "legacy-before" ? "pending" : "active");
      expect(f.setupRuns()).toBe(mode === "legacy-before" ? 0 : 1);
      expect(f.engineer).not.toHaveBeenCalled();
      legacy.mockRestore();
      // The deployed version left no preparation recovery ledger.
      f.authority.remove(preparationRecoveryKey);
      await f.reopen();
    }
    await f.reachAgent();
    const setup = f.task()!.setup!;
    expect(setup).toMatchObject({
      status: "passed",
      attempts: 1,
      history: [{ outcome: "passed" }],
    });
    expect(f.current().store.attemptId).toBe(attempt);
    expect(f.setupRuns()).toBe(1);
    const after = f.store().readSetupArtifact(setup.after!);
    expect(Buffer.byteLength(JSON.stringify(after))).toBeGreaterThan(16 * 1024 * 1024);
    expect(() => f.store().readPrimaryResultArtifact(setup.after!)).toThrow(/limit|Unsafe/);
    const worktree = runTaskResources(f.current().store.read()!).path;
    expect(fs.readFileSync(path.join(worktree, "setup-output.txt"), "utf8")).toBe(
      "preserve setup work",
    );
  },
  30_000,
);

it.each(["capture", "artifact", "checkpoint"] as const)(
  "bounds preparation %s failures across polls and ownership takeover before verified Failed",
  async (failure) => {
    const f = await fixture();
    const originalWrite = TaskExecutionStore.prototype.writeSetupArtifact;
    const originalUpdate = TaskExecutionStore.prototype.compareAndSwap;
    const failing =
      failure === "capture"
        ? vi
            .spyOn(f.git, "getIgnoredFiles")
            .mockRejectedValue(new Error("inventory capture defect"))
        : failure === "artifact"
          ? vi
              .spyOn(TaskExecutionStore.prototype, "writeSetupArtifact")
              .mockImplementation(function (this: TaskExecutionStore, id, value) {
                if (id.includes("after")) throw new Error("inventory persistence defect");
                return originalWrite.call(this, id, value);
              })
          : vi.spyOn(TaskExecutionStore.prototype, "compareAndSwap").mockImplementation(function (
              this: TaskExecutionStore,
              id,
              revision,
              record,
              terminal,
            ) {
              if (record.phase === "planning" && record.setup?.status === "passed")
                throw new Error("setup checkpoint defect");
              return originalUpdate.call(this, id, revision, record, terminal);
            });
    for (let count = 1; count <= 3; count++) {
      await f.poll();
      expect(f.state()?.internalFailures).toBe(count);
      expect(f.task()?.phase).toBe("planning");
      await f.reopen();
      const calls = failing.mock.calls.length;
      for (let i = 0; i < 5; i++) await f.poll();
      expect(failing.mock.calls.length).toBe(calls);
      f.due();
    }
    const failingCalls = () =>
      failure === "checkpoint"
        ? (
            failing.mock.calls as unknown as [
              string,
              number,
              { phase?: string; setup?: { status?: string } },
            ][]
          ).filter(
            ([, , record]) => record.phase === "planning" && record.setup?.status === "passed",
          ).length
        : failing.mock.calls.length;
    const calls = failingCalls();
    await f.poll();
    expect(failingCalls()).toBe(calls);
    expect(f.card.idList).toBe(f.project.trello.failedListId);
    expect(f.current().store.read()).toMatchObject({
      lifecycle: "failed",
      terminalSync: "verified",
    });
    expect(f.task()?.terminalFailure).toMatchObject({ outcome: "confirmed" });
    expect(
      f.requests.filter((r) => r === `POST:/1/cards/${f.card.id}/actions/comments`),
    ).toHaveLength(1);
    expect(f.setupRuns()).toBe(failure === "capture" ? 0 : 1);
    expect(f.engineer).not.toHaveBeenCalled();
    expect(fs.existsSync(runTaskResources(f.current().store.read()!).path)).toBe(true);
    expect(
      f.current().run(() => new TaskMutationQueue(f.project.contextRoot, f.project).getActive()),
    ).toBeNull();
    await f.current().releaseVerifiedTerminal();
  },
  30_000,
);

it("recovers a transient post-setup artifact failure at its deadline without reinstalling", async () => {
  const f = await fixture();
  const original = TaskExecutionStore.prototype.writeSetupArtifact;
  let reject = true;
  vi.spyOn(TaskExecutionStore.prototype, "writeSetupArtifact").mockImplementation(function (
    this: TaskExecutionStore,
    id,
    value,
  ) {
    if (id.includes("after") && reject) throw new Error("temporary artifact write failure");
    return original.call(this, id, value);
  });
  await f.poll();
  expect(f.state()?.internalFailures).toBe(1);
  expect(f.setupRuns()).toBe(1);
  reject = false;
  await f.reopen();
  await f.poll();
  expect(f.engineer).not.toHaveBeenCalled();
  f.due();
  await f.reachAgent();
  expect(f.task()?.setup?.status).toBe("passed");
  expect(f.setupRuns()).toBe(1);
  expect(f.sink.filter((text) => text.includes("Event: Attention Required"))).toHaveLength(1);
});

it("paces missing stopped-process evidence after exhaustion without retrying setup capture", async () => {
  const f = await fixture();
  const original = TaskExecutionStore.prototype.writeSetupArtifact;
  const writes = vi
    .spyOn(TaskExecutionStore.prototype, "writeSetupArtifact")
    .mockImplementation(function (this: TaskExecutionStore, id, value) {
      if (id.includes("after")) throw new Error("persistent artifact failure");
      return original.call(this, id, value);
    });
  for (let i = 0; i < 3; i++) {
    await f.poll();
    f.due();
  }
  const metadata = path.join(
    f.store().processExecutionDirectory(f.card.id)!,
    f.task()!.setup!.executionId!,
    "execution.json",
  );
  // Hide the persisted record rather than treating absence of a PID as proof.
  const evidence = fs.readFileSync(metadata);
  fs.renameSync(metadata, `${metadata}.preserved`);
  const before = writes.mock.calls.length;
  await f.reopen();
  for (let i = 0; i < 3; i++) {
    await f.poll();
    expect(f.state()).toMatchObject({ internalFailures: 3, kind: "safety" });
    expect(f.card.idList).toBe(f.project.trello.workingListId);
    expect(writes.mock.calls).toHaveLength(before);
    f.due();
  }
  fs.writeFileSync(metadata, evidence, { mode: 0o600 });
  await f.poll();
  expect(f.card.idList).toBe(f.project.trello.failedListId);
  expect(f.setupRuns()).toBe(1);
  expect(f.engineer).not.toHaveBeenCalled();
});

it("retains a pending Failed transition through a Trello outage and confirms it after restart", async () => {
  const f = await fixture();
  vi.spyOn(f.git, "getIgnoredFiles").mockRejectedValue(new Error("inventory capture defect"));
  for (let i = 0; i < 3; i++) {
    await f.poll();
    f.due();
  }
  const getCards = f.trello.getCards.bind(f.trello);
  const outage = vi.spyOn(f.trello, "getCards").mockImplementation(async (listId) => {
    if (listId === f.project.trello.failedListId)
      throw new TrelloRequestError("list lookup", "Trello unavailable", {
        retryable: true,
        status: 503,
      });
    return getCards(listId);
  });
  await f.poll();
  expect(f.task()?.terminalFailure?.outcome).toBe("pending");
  expect(f.current().store.read()?.terminalSync).not.toBe("verified");
  expect(f.card.idList).toBe(f.project.trello.workingListId);
  expect(f.state()?.kind).toBe("terminal");
  await f.reopen();
  outage.mockRestore();
  await f.poll();
  expect(f.card.idList).toBe(f.project.trello.workingListId);
  f.due();
  await f.poll();
  expect(f.card.idList).toBe(f.project.trello.failedListId);
  expect(f.task()?.terminalFailure?.outcome).toBe("confirmed");
  await f.current().releaseVerifiedTerminal();
  expect(
    f.requests.filter((r) => r === `POST:/1/cards/${f.card.id}/actions/comments`),
  ).toHaveLength(1);
  expect(f.engineer).not.toHaveBeenCalled();
});

it("does not charge preparation recovery for shutdown", async () => {
  const f = await fixture();
  const controller = new AbortController();
  vi.spyOn(f.git, "getIgnoredFiles").mockImplementation(async () => {
    controller.abort();
    throw new Error("cancelled inventory capture");
  });
  await expect(f.poll(controller.signal)).rejects.toThrow("cancelled inventory capture");
  expect(f.state()).toBeNull();
  expect(f.task()?.setup?.attempts).toBe(0);
  expect(f.sink).toEqual([]);
  expect(f.engineer).not.toHaveBeenCalled();
});

it.each(["trello-outage", "pending-mutation"] as const)(
  "does not charge %s to the internal preparation budget",
  async (condition) => {
    const f = await fixture();
    const original = f.trello.getCardAttachments.bind(f.trello);
    const outage = vi
      .spyOn(f.trello, "getCardAttachments")
      .mockRejectedValue(
        condition === "pending-mutation"
          ? new WorkflowMutationWaitingError()
          : new TrelloRequestError("attachment metadata", "Trello temporarily unavailable", {
              retryable: true,
              status: 503,
            }),
      );
    for (let i = 0; i < 4; i++) {
      await f.poll();
      expect(f.state()).toMatchObject({
        internalFailures: 0,
        kind: condition === "pending-mutation" ? "safety" : "dependency",
      });
      expect(f.card.idList).toBe(f.project.trello.workingListId);
      f.due();
    }
    outage.mockImplementation(original);
    await f.reachAgent();
    expect(f.setupRuns()).toBe(1);
  },
);

it.each(["open-pr", "github-outage"] as const)(
  "keeps exhausted preparation owned for %s without resuming unsafe work",
  async (condition) => {
    const f = await fixture();
    const capture = vi
      .spyOn(f.git, "getIgnoredFiles")
      .mockRejectedValue(new Error("inventory defect"));
    for (let i = 0; i < 3; i++) {
      await f.poll();
      f.due();
    }
    if (condition === "open-pr")
      f.lookupPr.mockResolvedValue({
        state: "OPEN",
        url: "https://github.com/owner/setup/pull/1",
      } as Awaited<ReturnType<typeof f.github.findPullRequestState>>);
    else f.lookupPr.mockRejectedValue(new Error("GitHub HTTP 503"));
    for (let i = 0; i < 2; i++) {
      await f.poll();
      expect(f.card.idList).toBe(f.project.trello.workingListId);
      expect(f.task()?.terminalFailure).toBeUndefined();
      expect(f.state()).toMatchObject({
        internalFailures: 3,
        kind: condition === "open-pr" ? "safety" : "dependency",
      });
      expect(capture).toHaveBeenCalledTimes(3);
      f.due();
    }
    f.lookupPr.mockResolvedValue(null);
    await f.poll();
    expect(f.card.idList).toBe(f.project.trello.failedListId);
    expect(f.engineer).not.toHaveBeenCalled();
  },
);
