import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import { RunStore } from "../src/task-session/run-store.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import type { TaskExecutionRecord } from "../src/task-session/task-execution-record.js";
import { reconcileSessionCreation } from "../src/task-session/reconcile-session-creation.js";
import { hasDueTaskSessionRecoveryWait } from "../src/orchestrator/run-orchestrator.js";
import { beginProcessEvidence, withTaskProcessArtifacts } from "../src/process/process-runtime.js";
import { runWithPrimaryTaskSession } from "../src/task-session/primary-task-session.js";
import { OpenCodeClient, type RunOpenCode } from "../src/opencode/opencode-client.js";
import type { ListedOpenCodeSession } from "../src/opencode/inspect-primary-session.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import {
  runTaskSessionWorkflow,
  type RunTaskSessionWorkflowOptions,
} from "../src/orchestrator/run-task-session-workflow.js";
import { CommandRunner } from "../src/process/command-runner.js";
import type { TrelloClient } from "../src/trello/trello-client.js";
import type { GitClient } from "../src/git/git-client.js";
import type { GitHubClient } from "../src/github/github-client.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(
  status:
    | "success"
    | "nonzero"
    | "interrupted"
    | "running"
    | "outage"
    | "not-dispatched"
    | "evidence-failure"
    | "spawn-failure" = "success",
  patch: Partial<TaskExecutionRecord> = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-creation-recovery-"));
  roots.push(root);
  const runtime = path.join(root, "runtime"),
    cwd = path.join(root, "worktrees", "card");
  fs.mkdirSync(cwd, { recursive: true });
  const project = {
    id: "project",
    contextRoot: runtime,
    autoMerge: false,
    repository: {
      path: path.join(root, "source"),
      worktreeRoot: path.dirname(cwd),
      github: "owner/repo",
      defaultBranch: "main",
    },
    trello: {
      boardId: "board",
      readyListId: "ready",
      workingListId: "working",
      reviewListId: "review",
      failedListId: "failed",
      doneListId: "done",
      backlogListId: "backlog",
    },
    opencode: {
      timeoutMinutes: 1,
      implementation: {},
      review: {},
      remediation: { maxPasses: 1 },
      commit: {},
    },
  } as ProjectConfig & { contextRoot: string };
  fs.mkdirSync(project.repository.path);
  const evidence = withTaskProcessArtifacts(
    { root: runtime, projectId: "project", cardId: "card", attemptId: "attempt" },
    () => beginProcessEvidence("opencode run", cwd),
  );
  evidence.dispatched(undefined);
  const output = JSON.stringify({
    type: "text",
    sessionID: "ses_original",
    part: { type: "text", text: "retained planning output" },
  });
  const exitedSuccessfully = status === "success" || status === "evidence-failure";
  if (status !== "running")
    evidence.finish(status === "outage" ? "nonzero" : status, {
      exitCode: exitedSuccessfully ? 0 : 1,
      ...(status === "evidence-failure" ? { treeStopped: true } : {}),
      ...(status === "outage" ? { failureClassification: "dependency-outage" } : {}),
      ...(exitedSuccessfully ? { sessionId: "ses_original" } : {}),
      result: {
        exitCode: exitedSuccessfully ? 0 : 1,
        output,
        errorOutput: "",
        processExecutionId: evidence.executionId,
        ...(status === "outage" ? { failureClassification: "dependency-outage" } : {}),
        ...(exitedSuccessfully ? { sessionId: "ses_original" } : {}),
      },
    });
  const task: TaskExecutionRecord = {
    version: 1,
    projectId: "project",
    cardId: "card",
    phase: "attention-required",
    operationKey: "operation",
    revision: 1,
    sessionCreationStatus: "ambiguous",
    sessionCreationTitle: "creation-correlation",
    sessionCreationCommand: "opencode run",
    sessionCreationExecutionId: evidence.executionId,
    sessionCreationAttempts: 1,
    expectedBranch: "agent/card",
    retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    ...patch,
  };
  const pinned = {
    integrationId: "integration",
    projectId: "project",
    boardId: "board",
    lists: {
      ready: "ready",
      working: "working",
      review: "review",
      failed: "failed",
      done: "done",
      backlog: "backlog",
    },
    repository: "owner/repo",
    repositoryPath: project.repository.path,
    worktreeRoot: path.dirname(cwd),
    storageRoot: runtime,
  };
  const lease = {
    integrationId: "integration",
    instanceId: "owner",
    token: "lease",
    assertHeld() {},
  };
  const runStore = new RunStore(runtime, "attempt", pinned, lease);
  runStore.create({
    version: 1,
    revision: 1,
    projectId: "project",
    cardId: "card",
    attemptId: "attempt",
    taskKind: "implementation",
    pinned,
    lifecycle: "waiting",
    checkpoint: "planning",
    publicationState: "none",
    operation: { id: "operation", kind: "attention-required", generation: 1 },
    wait: {
      reason: "task-attention-required",
      dependency: "operator",
      since: task.updatedAt,
      retryAt: null,
    },
    owner: { instanceId: "owner", token: "lease", generation: 1 },
    resources: [],
    pendingOperations: [],
    queue: [],
    budgets: {},
    sessions: {},
    artifacts: [],
    expectedTrelloListId: "working",
    terminalSync: "not-applicable",
    terminalEvidence: null,
    legacy: {},
    compatibility: { "task-execution-card": task },
    updatedAt: task.updatedAt,
  });
  let authority = new ProjectRunAuthority("project", runStore, 1);
  const store = () => new TaskExecutionStore(runtime, project);
  let sessions: ListedOpenCodeSession[] | null = [
    { id: "ses_original", directory: cwd, title: "creation-correlation" },
  ];
  const verifyOwnership = vi.fn(async () => true);
  const readSessions = vi.fn(async () => sessions);
  let now = Date.parse("2026-11-01T10:01:00.000Z");
  const recover = () =>
    authority.run(() =>
      reconcileSessionCreation({
        store: store(),
        cardId: "card",
        cwd,
        retryIntervalMs: 15_000,
        verifyOwnership,
        readSessions,
        now: () => now,
      }),
    );
  return {
    cwd,
    root,
    runStore,
    evidence,
    output,
    verifyOwnership,
    readSessions,
    recover,
    inventory(value: typeof sessions) {
      sessions = value;
    },
    tick() {
      now += 15_000;
    },
    read: () => authority.run(() => store().read("card")!),
    restart() {
      authority = new ProjectRunAuthority(
        "project",
        new RunStore(runtime, "attempt", pinned, lease),
        1,
      );
    },
    replay: (client: OpenCodeClient) =>
      authority.run(() =>
        runWithPrimaryTaskSession(
          store(),
          client,
          "project",
          "card",
          { cwd, prompt: "plan", timeoutMilliseconds: 1000, signal: new AbortController().signal },
          {},
          { role: "advisory", operationId: "operation:planning", activity: "planning" },
        ),
      ),
    enqueue: () =>
      authority.run(() => {
        const queue = new TaskMutationQueue(runtime, project);
        queue.enqueue({
          eventId: "implementation:card",
          projectId: "project",
          cardId: "card",
          kind: "implementation",
          operationKey: "operation",
          enqueuedAt: task.createdAt,
        });
        queue.claimNext();
        queue.fail("implementation:card");
      }),
    workflow: (
      dependencies: Pick<
        RunTaskSessionWorkflowOptions,
        "trello" | "git" | "github" | "openCode" | "commands" | "emailNotifier"
      >,
    ) =>
      authority.run(() =>
        runTaskSessionWorkflow({
          ...dependencies,
          project,
          signal: new AbortController().signal,
          prepareAttachmentContext: async () => undefined,
          retryIntervalMs: 15_000,
        }),
      ),
  };
}

it("reconciles a completed unbound session after restart and replays its original plan without dispatch", async () => {
  const f = fixture();
  f.restart();
  expect(hasDueTaskSessionRecoveryWait(f.runStore.read())).toBe(true);
  expect(await f.recover()).toBe("recovered");
  expect(f.read()).toMatchObject({
    phase: "planning",
    primarySessionId: "ses_original",
    sessionCreationStatus: "bound",
  });
  f.restart();
  const run = vi.fn();
  await expect(f.replay(new OpenCodeClient(run))).resolves.toMatchObject({
    sessionId: "ses_original",
    output: f.output,
  });
  expect(run).not.toHaveBeenCalled();
  expect(await f.recover()).toBe("not-applicable");
});

it("uses creation correlation to recover an original session when the final event ID was not captured", async () => {
  const f = fixture("interrupted");
  expect(await f.recover()).toBe("recovered");
  expect(f.read().primarySessionId).toBe("ses_original");
});

it("hands a known lost original session to context reconstruction instead of creating a context-free replacement", async () => {
  const f = fixture();
  f.inventory([]);
  expect(await f.recover()).toBe("recovered");
  expect(f.read()).toMatchObject({
    primarySessionId: "ses_original",
    sessionCreationStatus: "bound",
  });
  expect(f.read().sessionCreationResult).toBeDefined();
  expect(f.read().sessionCreationFailures).toBeUndefined();
});

it.each(["corrupt-result", "evidence-failure", "corrupt-cache"])(
  "reacquires unavailable planning advice in the same original session (%s)",
  async (condition) => {
    const f = fixture(condition === "evidence-failure" ? "evidence-failure" : "success");
    if (condition === "corrupt-result")
      fs.writeFileSync(path.join(path.dirname(f.evidence.metadataPath), "result.json"), "{}");
    expect(await f.recover()).toBe("recovered");
    expect(f.read().primarySessionId).toBe("ses_original");
    if (condition === "corrupt-cache")
      fs.writeFileSync(f.read().sessionCreationResult!.path!, "{}");
    const run = vi.fn<RunOpenCode>(async () => ({
      exitCode: 0,
      output: f.output,
      errorOutput: "",
    }));
    await expect(f.replay(new OpenCodeClient(run))).resolves.toMatchObject({
      sessionId: "ses_original",
    });
    expect(run).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: "ses_original" }),
    );
    expect(run.mock.calls[0]?.[0]).not.toHaveProperty("captureSessionId", true);
    expect(f.read().sessionCreationAttempts).toBe(1);
  },
);

it.each(["creating", "ambiguous"] as const)(
  "automatically retries a verified stopped %s creation with no surviving session",
  async (sessionCreationStatus) => {
    const f = fixture("nonzero", { sessionCreationStatus });
    f.inventory([]);
    expect(await f.recover()).toBe("recovered");
    expect(f.read()).toMatchObject({ phase: "planning", sessionCreationFailures: 1 });
    expect(f.read().sessionCreationStatus).toBeUndefined();
    expect(await f.recover()).toBe("not-applicable");
    expect(f.read().sessionCreationFailures).toBe(1);
  },
);

it("exhausts the durable genuine-failure budget into pending verified Failed handling", async () => {
  const f = fixture("nonzero", { sessionCreationFailures: 2 });
  f.inventory([]);
  expect(await f.recover()).toBe("failed");
  expect(f.read()).toMatchObject({
    phase: "attention-required",
    sessionCreationFailures: 3,
    terminalFailure: { kind: "implementation", outcome: "pending" },
  });
  expect(f.runStore.read()?.publicationState).toBe("none");
});

it("the production coordinator moves exhausted creation to Failed, explains it, and releases ownership after readback", async () => {
  const f = fixture("nonzero", { sessionCreationFailures: 2 });
  f.enqueue();
  let list = "working";
  const card = () => ({
    id: "card",
    name: "Task",
    desc: "Task",
    idLabels: ["feature"],
    idList: list,
    url: "https://trello.com/c/card",
  });
  const move = vi.fn(async (_id: string, destination: string) => {
    list = destination;
    return card();
  });
  const comment = vi.fn(async () => undefined);
  const trello = {
    getCard: async () => card(),
    getCards: async (id: string) => (id === list ? [card()] : []),
    moveCard: move,
    addComment: comment,
  } as unknown as TrelloClient;
  const run = vi.fn();
  await f.workflow({
    trello,
    git: {
      getCurrentBranch: async () => "agent/card",
      getRebaseState: async () => null,
    } as unknown as GitClient,
    github: { findPullRequestState: async () => null } as unknown as GitHubClient,
    openCode: new OpenCodeClient(run),
    commands: new CommandRunner(async () => ({ exitCode: 0, output: "[]" })),
  });
  expect(move).toHaveBeenCalledExactlyOnceWith("card", "failed");
  expect(comment).toHaveBeenCalledTimes(1);
  expect(comment.mock.calls[0]).toBeDefined();
  expect(f.runStore.read()).toMatchObject({ lifecycle: "failed", terminalSync: "verified" });
  expect(f.read().terminalFailure?.outcome).toBe("confirmed");
  expect(run).not.toHaveBeenCalled();
});

it("the production coordinator rechecks unknown creation without duplicate attention notifications or writers", async () => {
  const f = fixture("running");
  f.enqueue();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
  const card = {
    id: "card",
    name: "Task",
    desc: "Task",
    idLabels: ["feature"],
    idList: "working",
    url: "https://trello.com/c/card",
  };
  const move = vi.fn();
  const run = vi.fn<RunOpenCode>();
  const send = vi.fn(async () => undefined);
  const dependencies = {
    trello: {
      getCard: async () => card,
      getCards: async (id: string) => (id === "working" ? [card] : []),
      moveCard: move,
    } as unknown as TrelloClient,
    git: {
      getCurrentBranch: async () => "agent/card",
      getRebaseState: async () => null,
    } as unknown as GitClient,
    github: { findPullRequestState: async () => null } as unknown as GitHubClient,
    openCode: new OpenCodeClient(run),
    commands: new CommandRunner(async () => ({ exitCode: 0, output: "[]" })),
    emailNotifier: { send },
  };
  for (let poll = 0; poll < 5; poll++) {
    await f.workflow(dependencies);
    await vi.advanceTimersByTimeAsync(15_000);
  }
  expect(send).toHaveBeenCalledTimes(1);
  expect(move).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(f.read().sessionCreationAttentionNotified).toBe(true);
  expect(f.read().recoveryWait?.attempts).toBe(5);
  expect(f.runStore.read()?.lifecycle).toBe("waiting");
});

it("does not charge genuine failure allowance for a verified provider outage", async () => {
  const f = fixture("outage", { sessionCreationFailures: 2 });
  f.inventory([]);
  expect(await f.recover()).toBe("recovered");
  expect(f.read().sessionCreationFailures).toBe(2);
  expect(f.read().terminalFailure).toBeUndefined();
});

it("does not charge initial-session crash recovery for an intentional stopped shutdown", async () => {
  const f = fixture("interrupted", { sessionCreationFailures: 2 });
  f.inventory([]);
  expect(await f.recover()).toBe("recovered");
  expect(f.read().sessionCreationFailures).toBe(2);
  expect(f.read().terminalFailure).toBeUndefined();
});

it("does not charge a cancellation before initial process preparation as a genuine startup failure", async () => {
  const f = fixture("running", {
    sessionCreationExecutionId: undefined,
    sessionCreationCancelled: true,
    sessionCreationFailures: 2,
  });
  f.inventory([]);
  expect(await f.recover()).toBe("recovered");
  expect(f.read().sessionCreationFailures).toBe(2);
});

it.each(["not-dispatched", "spawn-failure"] as const)(
  "bounds conclusive %s startup failures even before a child starts",
  async (status) => {
    const f = fixture(status, { sessionCreationFailures: 2 });
    f.inventory([]);
    expect(await f.recover()).toBe("failed");
    expect(f.read().sessionCreationFailures).toBe(3);
  },
);

it("automatically resumes when previously running evidence becomes conclusively stopped", async () => {
  const f = fixture("running");
  expect(await f.recover()).toBe("waiting");
  f.evidence.finish("success", {
    exitCode: 0,
    sessionId: "ses_original",
    result: {
      exitCode: 0,
      sessionId: "ses_original",
      output: f.output,
      errorOutput: "",
      processExecutionId: f.evidence.executionId,
    },
  });
  expect(await f.recover()).toBe("waiting");
  f.tick();
  expect(await f.recover()).toBe("recovered");
  expect(f.read().primarySessionId).toBe("ses_original");
  expect(f.read().recoveryWait).toBeUndefined();
});

it("keeps unknown process termination paced and owned instead of assuming a missing session permits redispatch", async () => {
  const f = fixture("running");
  f.inventory([]);
  expect(await f.recover()).toBe("waiting");
  expect(f.readSessions).not.toHaveBeenCalled();
  expect(f.read().recoveryWait).toMatchObject({
    retryAt: "2026-11-01T10:01:15.000Z",
    notificationId: "operation/session-creation",
  });
  expect(f.runStore.read()?.lifecycle).toBe("waiting");
  expect(hasDueTaskSessionRecoveryWait(f.runStore.read(), Date.parse("2026-11-01T10:01:14Z"))).toBe(
    false,
  );
  expect(hasDueTaskSessionRecoveryWait(f.runStore.read(), Date.parse("2026-11-01T10:01:15Z"))).toBe(
    true,
  );
});

it.each(["unavailable", "duplicate", "wrong-directory", "unassociated", "ownership"])(
  "preserves ambiguous evidence without starting another session (%s)",
  async (condition) => {
    const f = fixture();
    if (condition === "unavailable") f.inventory(null);
    if (condition === "duplicate")
      f.inventory([
        { id: "ses_original", directory: f.cwd },
        { id: "ses_other", directory: f.cwd, title: "creation-correlation" },
      ]);
    if (condition === "wrong-directory")
      f.inventory([{ id: "ses_original", directory: "/unrelated" }]);
    if (condition === "unassociated") f.inventory([{ id: "ses_other", directory: f.cwd }]);
    if (condition === "ownership") f.verifyOwnership.mockResolvedValue(false);
    expect(await f.recover()).toBe("waiting");
    expect(f.read().primarySessionId).toBeUndefined();
    expect(f.read().sessionCreationFailures).toBeUndefined();
  },
);

it("retries a new creation intent proven never dispatched but keeps legacy missing provenance explicit", async () => {
  const fresh = fixture("running", {
    sessionCreationStatus: "creating",
    sessionCreationExecutionId: undefined,
  });
  fresh.inventory([]);
  expect(await fresh.recover()).toBe("recovered");
  expect(fresh.read().sessionCreationFailures).toBe(0);
  const legacy = fixture("running", {
    sessionCreationExecutionId: undefined,
    sessionCreationTitle: undefined,
  });
  legacy.inventory([]);
  expect(await legacy.recover()).toBe("waiting");
  expect(legacy.read().recoveryWait?.reason).toContain("operator evidence");
});
