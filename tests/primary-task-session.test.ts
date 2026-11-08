import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import {
  OpenCodeClient,
  type OpenCodeRunOptions,
  type RunOpenCode,
} from "../src/opencode/opencode-client.js";
import {
  assertPrimarySessionReconstructionReadOnly,
  PrimarySessionReconstructionRequiredError,
  runWithPrimaryTaskSession as rawRunWithPrimaryTaskSession,
  type PrimaryExecutionIdentity,
  type PrimarySessionRecoveryOptions,
} from "../src/task-session/primary-task-session.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import type { TaskExecutionRecord } from "../src/task-session/task-execution-record.js";

const advisoryFixtureExecution = {
  role: "advisory",
  operationId: "session-lifecycle-fixture",
} as const;

function runWithPrimaryTaskSession(
  store: Parameters<typeof rawRunWithPrimaryTaskSession>[0],
  openCode: Parameters<typeof rawRunWithPrimaryTaskSession>[1],
  projectId: Parameters<typeof rawRunWithPrimaryTaskSession>[2],
  cardId: Parameters<typeof rawRunWithPrimaryTaskSession>[3],
  runOptions: Parameters<typeof rawRunWithPrimaryTaskSession>[4],
  recovery: PrimarySessionRecoveryOptions = {},
  execution: PrimaryExecutionIdentity = advisoryFixtureExecution,
): ReturnType<typeof rawRunWithPrimaryTaskSession> {
  return rawRunWithPrimaryTaskSession(
    store,
    openCode,
    projectId,
    cardId,
    runOptions,
    recovery,
    execution,
  );
}

let temporaryRoot: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();

  if (temporaryRoot !== undefined) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

function createFixture(): {
  project: ProjectConfig;
  store: TaskExecutionStore;
  root: string;
} {
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-primary-session-"),
  );
  const project = {
    id: "project-one",
    repository: {
      path: path.join(temporaryRoot, "repository"),
      worktreeRoot: path.join(temporaryRoot, "worktrees"),
    },
  } as ProjectConfig;
  fs.mkdirSync(project.repository.path);
  fs.mkdirSync(project.repository.worktreeRoot);

  const root = path.join(temporaryRoot, "runtime-state");
  const store = new TaskExecutionStore(root, project);

  return { project, store, root };
}

function createRecord(
  projectId = "project-one",
  cardId = "card-one",
  overrides: Partial<TaskExecutionRecord> = {},
): TaskExecutionRecord {
  return {
    version: 1,
    projectId,
    cardId,
    phase: "planning",
    operationKey: "initial-planning",
    revision: 1,
    retryCounters: {
      validation: 0,
      review: 0,
      ci: 0,
      humanFeedback: 0,
    },
    createdAt: "2026-10-24T09:00:00.000Z",
    updatedAt: "2026-10-24T09:00:00.000Z",
    ...overrides,
  };
}

function createRunOptions(
  prompt = "Create a task plan",
): Omit<OpenCodeRunOptions, "sessionId" | "captureSessionId"> {
  return {
    cwd: "/owned/worktree",
    model: "planning-model",
    variant: "high",
    timeoutMilliseconds: 60_000,
    prompt,
    signal: new AbortController().signal,
  };
}

function sessionEvent(sessionId: string): string {
  return JSON.stringify({ type: "step_start", sessionID: sessionId });
}

function recoveryBaseline() {
  return {
    sourceIdentity: `sha256:${"a".repeat(64)}`,
    head: "a".repeat(40),
    branch: "agent/card-one",
    branchRef: "a".repeat(40),
    refsIdentity: "refs-v1",
  };
}

describe("runWithPrimaryTaskSession", () => {
  it("rejects repository mutations during read-only reconstruction verification", () => {
    const before = {
      sourceIdentity: "sha256:before",
      head: "a".repeat(40),
      branch: "agent/card-one",
      branchRef: "a".repeat(40),
      refsIdentity: "refs-before",
    };
    expect(() =>
      assertPrimarySessionReconstructionReadOnly(before, {
        ...before,
        sourceIdentity: "sha256:changed",
      }),
    ).toThrow("read-only repository boundary");
  });
  it("persists a captured replacement as unverified when reconstruction exits nonzero", async () => {
    const { store, project } = createFixture();
    store.create(
      createRecord("project-one", "card-one", {
        phase: "implementation",
        expectedBranch: "agent/card-one",
        primarySessionId: "ses_lost",
        sessionCreationStatus: "bound",
      }),
    );
    const run = vi.fn<RunOpenCode>().mockResolvedValue({
      exitCode: 1,
      output: sessionEvent("ses_replacement"),
      errorOutput: "failed reconstruction",
    });
    const root = path.join(temporaryRoot!, "recovery");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, ".partial-publication.tmp"), "partial");
    const bundle = {
      version: 1 as const,
      projectId: "project-one",
      cardId: "card-one",
      attemptId: "attempt-one",
      repositoryPath: "/owned/worktree",
      repositoryHead: "a".repeat(40),
      card: {
        title: "Task",
        description: "Current task",
        current: true as const,
      },
      plan: { status: "absent" as const },
      attachmentManifest: { status: "absent" as const },
      currentDiff: "diff inventory",
      history: "history inventory",
      feedback: { status: "absent" as const, references: [] },
    };
    const result = await runWithPrimaryTaskSession(
      store,
      new OpenCodeClient(run),
      "project-one",
      "card-one",
      { ...createRunOptions(), readOnly: true },
      {
        inspect: async () => "confirmed-absent",
        context: bundle,
        contextDirectory: root,
        forbiddenPaths: [
          project.repository.path,
          project.repository.worktreeRoot,
        ],
        attemptId: "attempt-one",
        baseline: recoveryBaseline(),
      },
      {
        role: "reconstruction",
        operationId: "attempt-one:reconstruction",
        readOnlyAcknowledged: true,
      },
    );
    expect(result.exitCode).toBe(1);
    expect(store.read("card-one")).toMatchObject({
      primarySessionId: "ses_replacement",
      sessionRecovery: {
        status: "replacement-bound",
        reconstructionBaseline: recoveryBaseline(),
      },
    });
    const artifactPath = store.read("card-one")!.sessionRecovery!.contextPath!;
    fs.writeFileSync(artifactPath, "partial artifact");
    await expect(
      runWithPrimaryTaskSession(
        store,
        new OpenCodeClient(run),
        "project-one",
        "card-one",
        createRunOptions(),
        {
          inspect: async () => "reachable",
          context: bundle,
          contextDirectory: root,
          forbiddenPaths: [
            project.repository.path,
            project.repository.worktreeRoot,
          ],
          attemptId: "attempt-one",
          baseline: recoveryBaseline(),
        },
      ),
    ).rejects.toThrow("corrupt");
    expect(run).toHaveBeenCalledOnce();
    await expect(
      runWithPrimaryTaskSession(
        store,
        new OpenCodeClient(run),
        "project-one",
        "card-one",
        createRunOptions(),
        {
          inspect: async () => "reachable",
          context: bundle,
          forbiddenPaths: [
            project.repository.path,
            project.repository.worktreeRoot,
          ],
          attemptId: "attempt-one",
          baseline: recoveryBaseline(),
          persistArtifact: () => ({
            reference: `sha256:${"0".repeat(64)}`,
            path: path.join(project.repository.path, "context.json"),
          }),
        },
      ),
    ).rejects.toThrow("overlaps a repository or worktree");
    expect(run).toHaveBeenCalledOnce();
  });
  it("captures and persists the actual created session before returning", async () => {
    const { store } = createFixture();
    store.create(createRecord());
    const runOpenCode = vi.fn<RunOpenCode>().mockResolvedValue({
      exitCode: 0,
      output: sessionEvent("ses_primary-one"),
      errorOutput: "",
    });
    const result = await runWithPrimaryTaskSession(
      store,
      new OpenCodeClient(runOpenCode),
      "project-one",
      "card-one",
      { ...createRunOptions(), readOnly: true },
    );

    expect(result.sessionId).toBe("ses_primary-one");
    expect(runOpenCode).toHaveBeenCalledWith(
      expect.objectContaining({ captureSessionId: true }),
    );
    expect(store.read("card-one")).toMatchObject({
      primarySessionId: "ses_primary-one",
      sessionCreationStatus: "bound",
      revision: 3,
    });
  });

  it("always resumes the exact session already bound to the task", async () => {
    const { store } = createFixture();
    store.create(
      createRecord("project-one", "card-one", {
        primarySessionId: "ses_bound-session",
        sessionCreationStatus: "bound",
      }),
    );
    const runOpenCode = vi.fn<RunOpenCode>().mockResolvedValue({
      exitCode: 0,
      output: "continued",
      errorOutput: "",
    });

    await runWithPrimaryTaskSession(
      store,
      new OpenCodeClient(runOpenCode),
      "project-one",
      "card-one",
      createRunOptions("Continue implementation"),
    );

    expect(runOpenCode).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Continue implementation",
        sessionId: "ses_bound-session",
      }),
    );
    expect(runOpenCode.mock.calls[0]?.[0].captureSessionId).toBeUndefined();
  });
  it("does not build reconstruction context for a healthy bound session", async () => {
    const { store } = createFixture();
    store.create(
      createRecord("project-one", "card-one", {
        primarySessionId: "ses_live",
        sessionCreationStatus: "bound",
      }),
    );
    const run = vi
      .fn<RunOpenCode>()
      .mockResolvedValue({ exitCode: 0, output: "continued", errorOutput: "" });
    const buildContext = vi.fn(async () => {
      throw new Error("must remain lazy");
    });
    await runWithPrimaryTaskSession(
      store,
      new OpenCodeClient(run),
      "project-one",
      "card-one",
      { ...createRunOptions(), readOnly: true },
      { inspect: async () => "reachable", buildContext },
    );
    expect(buildContext).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
  });
  it("checks ambiguous replacement state before invoking lazy context construction", async () => {
    const { store } = createFixture();
    store.create(
      createRecord("project-one", "card-one", {
        primarySessionId: "ses_old",
        sessionCreationStatus: "bound",
        sessionRecovery: {
          originalSessionId: "ses_old",
          status: "replacement-creating",
        },
      }),
    );
    const buildContext = vi.fn(async () => {
      throw new Error("context must not be built");
    });
    await expect(
      runWithPrimaryTaskSession(
        store,
        new OpenCodeClient(vi.fn<RunOpenCode>()),
        "project-one",
        "card-one",
        createRunOptions(),
        { inspect: async () => "confirmed-absent", buildContext },
      ),
    ).rejects.toThrow("ambiguous");
    expect(buildContext).not.toHaveBeenCalled();
  });
  it("accepts a bound reconnect result without requiring a newly captured session ID", async () => {
    const { store, project } = createFixture();
    store.create(
      createRecord("project-one", "card-one", {
        phase: "implementation",
        expectedBranch: "agent/card-one",
        primarySessionId: "ses_replacement",
        sessionCreationStatus: "bound",
        sessionRecovery: {
          originalSessionId: "ses_lost",
          status: "replacement-bound",
          replacementSessionIds: ["ses_replacement"],
          reconstructionBaseline: recoveryBaseline(),
        },
      }),
    );
    const context = {
      version: 1 as const,
      projectId: "project-one",
      cardId: "card-one",
      attemptId: "attempt-one",
      repositoryPath: "/owned/worktree",
      repositoryHead: "a".repeat(40),
      card: {
        title: "Task",
        description: "Current task",
        current: true as const,
      },
      plan: { status: "absent" as const },
      attachmentManifest: { status: "absent" as const },
      currentDiff: "inventory",
      history: "history",
      feedback: { status: "absent" as const, references: [] },
    };
    const run = vi
      .fn<RunOpenCode>()
      .mockResolvedValue({ exitCode: 0, output: "restored", errorOutput: "" });
    const result = await runWithPrimaryTaskSession(
      store,
      new OpenCodeClient(run),
      "project-one",
      "card-one",
      { ...createRunOptions(), readOnly: true },
      {
        inspect: async () => "reachable",
        context,
        contextDirectory: path.join(temporaryRoot!, "context"),
        forbiddenPaths: [
          project.repository.path,
          project.repository.worktreeRoot,
        ],
        attemptId: "attempt-one",
        baseline: recoveryBaseline(),
      },
      {
        role: "reconstruction",
        operationId: "attempt-one:reconstruction",
        readOnlyAcknowledged: true,
      },
    );
    expect(result.sessionId).toBe("ses_replacement");
    expect(store.read("card-one")?.primarySessionId).toBe("ses_replacement");
  });
  it("does not reset a persisted preservation baseline after a restart", async () => {
    const { store, project } = createFixture();
    store.create(
      createRecord("project-one", "card-one", {
        phase: "implementation",
        expectedBranch: "agent/card-one",
        primarySessionId: "ses_replacement",
        sessionCreationStatus: "bound",
        sessionRecovery: {
          originalSessionId: "ses_lost",
          status: "replacement-bound",
          replacementSessionIds: ["ses_replacement"],
          reconstructionBaseline: recoveryBaseline(),
        },
      }),
    );
    const run = vi.fn<RunOpenCode>();
    const context = {
      version: 1 as const,
      projectId: "project-one",
      cardId: "card-one",
      attemptId: "attempt-one",
      repositoryPath: "/owned/worktree",
      repositoryHead: "a".repeat(40),
      card: {
        title: "Task",
        description: "Current task",
        current: true as const,
      },
      plan: { status: "absent" as const },
      attachmentManifest: { status: "absent" as const },
      currentDiff: "inventory",
      history: "history",
      feedback: { status: "absent" as const, references: [] },
    };
    await expect(
      runWithPrimaryTaskSession(
        store,
        new OpenCodeClient(run),
        "project-one",
        "card-one",
        createRunOptions(),
        {
          inspect: async () => "reachable",
          context,
          contextDirectory: path.join(temporaryRoot!, "context"),
          forbiddenPaths: [
            project.repository.path,
            project.repository.worktreeRoot,
          ],
          attemptId: "attempt-one",
          baseline: {
            ...recoveryBaseline(),
            sourceIdentity: `sha256:${"b".repeat(64)}`,
          },
        },
      ),
    ).rejects.toThrow("changed after replacement binding");
    expect(run).not.toHaveBeenCalled();
    expect(store.read("card-one")?.sessionRecovery?.status).toBe(
      "reconstruction-blocked",
    );
  });

  it("reconstructs only after confirmed absence and persists a hashed context bundle", async () => {
    const { store, project } = createFixture();
    store.create(
      createRecord("project-one", "card-one", {
        phase: "implementation",
        expectedBranch: "agent/card-one",
        primarySessionId: "ses_lost",
        sessionCreationStatus: "bound",
      }),
    );
    const runOpenCode = vi.fn<RunOpenCode>(async () => {
      expect(store.read("card-one")).toMatchObject({
        primarySessionId: "ses_lost",
        sessionCreationStatus: "bound",
        sessionRecovery: { status: "replacement-creating" },
      });
      return {
        exitCode: 0,
        output: sessionEvent("ses_replacement"),
        errorOutput: "",
      };
    });
    const contextDirectory = path.join(temporaryRoot!, "recovery-context");
    const result = await runWithPrimaryTaskSession(
      store,
      new OpenCodeClient(runOpenCode),
      "project-one",
      "card-one",
      { ...createRunOptions(), readOnly: true },
      {
        inspect: async () => "confirmed-absent",
        contextDirectory,
        context: {
          version: 1,
          projectId: "project-one",
          cardId: "card-one",
          attemptId: "attempt-one",
          repositoryPath: "/owned/worktree",
          repositoryHead: "a".repeat(40),
          card: {
            title: "current card",
            description: "Description",
            current: true,
          },
          plan: { status: "absent" },
          attachmentManifest: { status: "available", content: "[]" },
          currentDiff: "diff",
          history: "prior work",
          feedback: {
            status: "available",
            references: ["feedback:1"],
            content: JSON.stringify({ entries: [{ id: "feedback:1" }] }),
          },
        },
        forbiddenPaths: [
          project.repository.path,
          project.repository.worktreeRoot,
        ],
        attemptId: "attempt-one",
        baseline: recoveryBaseline(),
      },
      {
        role: "reconstruction",
        operationId: "attempt-one:reconstruction",
        readOnlyAcknowledged: true,
      },
    );
    expect(result.sessionId).toBe("ses_replacement");
    expect(store.read("card-one")).toMatchObject({
      primarySessionId: "ses_replacement",
      sessionRecovery: {
        originalSessionId: "ses_lost",
        status: "replacement-bound",
        contextReference: expect.stringMatching(/^sha256:/u),
      },
    });
    expect(
      store.read("card-one")?.sessionRecovery?.replacementSessionIds,
    ).toEqual(["ses_replacement"]);
    expect(fs.readdirSync(contextDirectory)).toHaveLength(1);
  });

  it("starts a new reconstruction lineage after verified recovery and a later repository edit/loss", async () => {
    const { store, project } = createFixture();
    store.create(
      createRecord("project-one", "card-one", {
        phase: "implementation",
        expectedBranch: "agent/card-one",
        primarySessionId: "ses_original-lost",
        sessionCreationStatus: "bound",
      }),
    );
    const contextDirectory = path.join(temporaryRoot!, "recovery-context");
    const context = (head: string) => ({
      version: 1 as const,
      projectId: "project-one",
      cardId: "card-one",
      attemptId: "attempt-one",
      repositoryPath: "/owned/worktree",
      repositoryHead: head,
      card: {
        title: "current card",
        description: "Current",
        current: true as const,
      },
      plan: { status: "absent" as const },
      attachmentManifest: { status: "available" as const, content: "[]" },
      currentDiff: `diff at ${head}`,
      history: "prior work",
      feedback: { status: "absent" as const, references: [] },
    });
    const options = {
      ...createRunOptions(),
      readOnly: true,
    };
    const first = await runWithPrimaryTaskSession(
      store,
      new OpenCodeClient(
        vi.fn<RunOpenCode>().mockResolvedValue({
          exitCode: 0,
          output: sessionEvent("ses_replacement-one"),
          errorOutput: "",
        }),
      ),
      "project-one",
      "card-one",
      options,
      {
        inspect: async () => "confirmed-absent",
        context: context("a".repeat(40)),
        contextDirectory,
        forbiddenPaths: [
          project.repository.path,
          project.repository.worktreeRoot,
        ],
        attemptId: "attempt-one",
        baseline: recoveryBaseline(),
      },
      {
        role: "reconstruction",
        operationId: "attempt-one:reconstruction:1",
        readOnlyAcknowledged: true,
      },
    );
    expect(first.sessionId).toBe("ses_replacement-one");
    const firstRecord = store.read("card-one")!;
    store.compareAndSwap("card-one", firstRecord.revision, {
      ...firstRecord,
      sessionRecovery: {
        ...firstRecord.sessionRecovery!,
        status: "reconstruction-verified",
        reconstructionBaseline: undefined,
      },
      revision: firstRecord.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    const editedBaseline = {
      ...recoveryBaseline(),
      head: "b".repeat(40),
      sourceIdentity: `sha256:${"b".repeat(64)}`,
    };
    const second = await runWithPrimaryTaskSession(
      store,
      new OpenCodeClient(
        vi.fn<RunOpenCode>().mockResolvedValue({
          exitCode: 0,
          output: sessionEvent("ses_replacement-two"),
          errorOutput: "",
        }),
      ),
      "project-one",
      "card-one",
      options,
      {
        inspect: async () => "confirmed-absent",
        context: context("b".repeat(40)),
        contextDirectory,
        forbiddenPaths: [
          project.repository.path,
          project.repository.worktreeRoot,
        ],
        attemptId: "attempt-one",
        baseline: editedBaseline,
      },
      {
        role: "reconstruction",
        operationId: "attempt-one:reconstruction:2",
        readOnlyAcknowledged: true,
      },
    );
    expect(second.sessionId).toBe("ses_replacement-two");
    expect(
      store.read("card-one")?.sessionRecovery?.replacementSessionIds,
    ).toEqual(["ses_replacement-one", "ses_replacement-two"]);
    expect(
      store.read("card-one")?.sessionRecovery?.contextLineage,
    ).toHaveLength(2);
    expect(store.read("card-one")?.primaryOperations).toBeUndefined();
  });

  it("waits on uncertain inspection and refuses replacement without complete context", async () => {
    const { store } = createFixture();
    store.create(
      createRecord("project-one", "card-one", {
        primarySessionId: "ses_lost",
        sessionCreationStatus: "bound",
      }),
    );
    const runOpenCode = vi.fn<RunOpenCode>();
    const openCode = new OpenCodeClient(runOpenCode);
    await expect(
      runWithPrimaryTaskSession(
        store,
        openCode,
        "project-one",
        "card-one",
        createRunOptions(),
        { inspect: async () => "unknown" },
      ),
    ).rejects.toThrow("unknown");
    await expect(
      runWithPrimaryTaskSession(
        store,
        openCode,
        "project-one",
        "card-one",
        createRunOptions(),
        {
          inspect: async () => "confirmed-absent",
          baseline: recoveryBaseline(),
        },
      ),
    ).rejects.toThrow("context is unavailable");
    expect(runOpenCode).not.toHaveBeenCalled();
  });

  it("hands off typed reconstruction when the original session disappears between reconciliation and dispatch", async () => {
    const { store } = createFixture();
    store.create(
      createRecord("project-one", "card-one", {
        phase: "implementation",
        expectedBranch: "agent/card-one",
        primarySessionId: "ses_primary",
        sessionCreationStatus: "bound",
      }),
    );
    const inspect = vi
      .fn<NonNullable<PrimarySessionRecoveryOptions["inspect"]>>()
      .mockResolvedValueOnce("reachable")
      .mockResolvedValueOnce("confirmed-absent");
    const openCode = vi.fn<RunOpenCode>();
    await expect(
      runWithPrimaryTaskSession(
        store,
        new OpenCodeClient(openCode),
        "project-one",
        "card-one",
        createRunOptions("primary work must not dispatch"),
        { inspect },
        {
          role: "primary",
          operationId: "attempt-one:implementation",
          activity: "implementation",
          inspectPending: async () => ({ status: "unknown" }),
        },
      ),
    ).rejects.toMatchObject<Partial<PrimarySessionReconstructionRequiredError>>(
      {
        name: "PrimarySessionReconstructionRequiredError",
        operationId: "attempt-one:implementation",
      },
    );
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(openCode).not.toHaveBeenCalled();
    expect(store.read("card-one")?.primaryOperations).toBeUndefined();
  });

  it("keeps sessions isolated by card and resumes them across a store restart", async () => {
    const { store, project, root } = createFixture();
    store.create(createRecord("project-one", "card-one"));
    store.create(
      createRecord("project-one", "card-two", {
        primarySessionId: "ses_card-two",
        sessionCreationStatus: "bound",
      }),
    );
    const createSession = vi.fn<RunOpenCode>().mockResolvedValue({
      exitCode: 0,
      output: sessionEvent("ses_card-one"),
      errorOutput: "",
    });
    await runWithPrimaryTaskSession(
      store,
      new OpenCodeClient(createSession),
      "project-one",
      "card-one",
      createRunOptions(),
    );

    const restartedStore = new TaskExecutionStore(root, project);
    const resumeSession = vi.fn<RunOpenCode>().mockResolvedValue({
      exitCode: 0,
      output: "continued after restart",
      errorOutput: "",
    });
    const openCode = new OpenCodeClient(resumeSession);

    await runWithPrimaryTaskSession(
      restartedStore,
      openCode,
      "project-one",
      "card-one",
      createRunOptions(),
    );
    await runWithPrimaryTaskSession(
      restartedStore,
      openCode,
      "project-one",
      "card-two",
      createRunOptions(),
    );

    expect(
      resumeSession.mock.calls.map(([options]) => options.sessionId),
    ).toEqual(["ses_card-one", "ses_card-two"]);
    expect(
      resumeSession.mock.calls.every(([options]) => !options.captureSessionId),
    ).toBe(true);
    expect(createSession).toHaveBeenCalledOnce();
  });

  it("allows only one concurrent session initialization for a task", async () => {
    const { store } = createFixture();
    store.create(createRecord());
    let runStarted: (() => void) | undefined;
    let finishRun:
      ((result: Awaited<ReturnType<RunOpenCode>>) => void) | undefined;
    const started = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    const runOpenCode = vi.fn<RunOpenCode>(
      () =>
        new Promise((resolve) => {
          finishRun = resolve;
          runStarted?.();
        }),
    );
    const openCode = new OpenCodeClient(runOpenCode);
    const firstRun = runWithPrimaryTaskSession(
      store,
      openCode,
      "project-one",
      "card-one",
      createRunOptions(),
    );
    await started;

    await expect(
      runWithPrimaryTaskSession(
        store,
        openCode,
        "project-one",
        "card-one",
        createRunOptions(),
      ),
    ).rejects.toThrow("ambiguous");
    expect(runOpenCode).toHaveBeenCalledOnce();

    finishRun?.({
      exitCode: 0,
      output: sessionEvent("ses_only-one"),
      errorOutput: "",
    });
    await expect(firstRun).resolves.toMatchObject({
      sessionId: "ses_only-one",
    });
    expect(store.read("card-one")).toMatchObject({
      sessionCreationStatus: "bound",
      primarySessionId: "ses_only-one",
    });
  });

  it("marks a missing capture ambiguous and never creates a replacement", async () => {
    const { store } = createFixture();
    store.create(createRecord());
    const runOpenCode = vi.fn<RunOpenCode>().mockResolvedValue({
      exitCode: 0,
      output: "no event ID",
      errorOutput: "diagnostic output",
    });
    const openCode = new OpenCodeClient(runOpenCode);

    await expect(
      runWithPrimaryTaskSession(
        store,
        openCode,
        "project-one",
        "card-one",
        createRunOptions(),
      ),
    ).rejects.toThrow("outcome is ambiguous");
    expect(store.read("card-one")).toMatchObject({
      sessionCreationStatus: "ambiguous",
    });

    await expect(
      runWithPrimaryTaskSession(
        store,
        openCode,
        "project-one",
        "card-one",
        createRunOptions(),
      ),
    ).rejects.toThrow("refusing to create a replacement");
    expect(runOpenCode).toHaveBeenCalledOnce();
  });

  it("refuses to guess after restart if a prior initialization was interrupted", async () => {
    const { store } = createFixture();
    const initial = createRecord();
    store.create(initial);
    store.compareAndSwap(initial.cardId, initial.revision, {
      ...initial,
      sessionCreationStatus: "creating",
      revision: 2,
      updatedAt: "2026-10-24T09:01:00.000Z",
    });
    const runOpenCode = vi.fn<RunOpenCode>();

    await expect(
      runWithPrimaryTaskSession(
        store,
        new OpenCodeClient(runOpenCode),
        "project-one",
        "card-one",
        createRunOptions(),
      ),
    ).rejects.toThrow("refusing to create a replacement");
    expect(runOpenCode).not.toHaveBeenCalled();
  });

  it("refuses a missing record before invoking OpenCode", async () => {
    const { store } = createFixture();
    const runOpenCode = vi.fn<RunOpenCode>();

    await expect(
      runWithPrimaryTaskSession(
        store,
        new OpenCodeClient(runOpenCode),
        "project-one",
        "missing-card",
        createRunOptions(),
      ),
    ).rejects.toThrow("without a task execution record");
    expect(runOpenCode).not.toHaveBeenCalled();
  });
});
