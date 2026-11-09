import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import {
  OpenCodeClient,
  OpenCodeTimeoutError,
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
import { createHash } from "node:crypto";
import { registerProcessSecrets } from "../src/process/process-runtime.js";
import { execFileSync } from "node:child_process";
import { GitClient } from "../src/git/git-client.js";
import { buildPrimarySessionContext } from "../src/task-session/build-primary-session-context.js";
import { RunStore } from "../src/task-session/run-store.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import { getTaskSessionSourceSnapshotIdentity } from "../src/task-session/source-snapshot.js";
import type { TaskExecutionRecord } from "../src/task-session/task-execution-record.js";
import { inspectPrimaryOperationEvidence } from "../src/task-session/inspect-primary-operation.js";

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
  it("recovers a bound advisory timeout only after process evidence confirms it stopped", async () => {
    const { store } = createFixture();
    store.create(
      createRecord("project-one", "card-one", {
        primarySessionId: "ses_planning",
        sessionCreationStatus: "bound",
      }),
    );
    const run = vi
      .fn<RunOpenCode>()
      .mockRejectedValueOnce(
        new OpenCodeTimeoutError(100, "exec-timeout", true),
      )
      .mockResolvedValueOnce({
        exitCode: 0,
        output: "planning advice",
        errorOutput: "",
        sessionId: "ses_planning",
      });
    const inspectPending = vi.fn(async (entry) => ({
      status: "stopped-after-dispatch" as const,
      operationId: entry.id,
      execution: entry.executions,
      sessionId: entry.lastSessionId,
    }));

    const result = await runWithPrimaryTaskSession(
      store,
      new OpenCodeClient(run),
      "project-one",
      "card-one",
      createRunOptions(),
      {},
      {
        role: "advisory",
        operationId: "initial-planning:planning",
        activity: "planning",
        inspectPending,
      },
    );

    expect(result.output).toBe("planning advice");
    expect(run).toHaveBeenCalledTimes(2);
    expect(inspectPending).toHaveBeenCalledOnce();
    expect(store.read("card-one")?.primaryOperations).toMatchObject({
      "initial-planning:planning": {
        role: "advisory",
        activity: "planning",
        executions: 2,
        status: "completed",
      },
    });
  });

  it("preserves ambiguous advisory timeout state and never retries on restart without stop proof", async () => {
    const { store, project, root } = createFixture();
    store.create(
      createRecord("project-one", "card-one", {
        primarySessionId: "ses_planning",
        sessionCreationStatus: "bound",
      }),
    );
    const run = vi
      .fn<RunOpenCode>()
      .mockRejectedValue(new OpenCodeTimeoutError(100, "exec-unknown", false));
    const inspectPending = vi.fn(async () => ({ status: "unknown" as const }));
    const execution = {
      role: "advisory" as const,
      operationId: "initial-planning:planning",
      activity: "planning",
      inspectPending,
    };

    await expect(
      runWithPrimaryTaskSession(
        store,
        new OpenCodeClient(run),
        "project-one",
        "card-one",
        createRunOptions(),
        {},
        execution,
      ),
    ).rejects.toThrow("waiting for authoritative reconciliation");
    const restartedStore = new TaskExecutionStore(root, project);
    await expect(
      runWithPrimaryTaskSession(
        restartedStore,
        new OpenCodeClient(run),
        "project-one",
        "card-one",
        createRunOptions(),
        {},
        execution,
      ),
    ).rejects.toThrow("waiting for authoritative reconciliation");

    expect(run).toHaveBeenCalledOnce();
    expect(restartedStore.read("card-one")?.primaryOperations).toMatchObject({
      "initial-planning:planning": { status: "ambiguous", executions: 1 },
    });
  });

  it("waits on a classified original-session outage before reconstruction acknowledgement", async () => {
    const { store, project } = createFixture();
    const ackId = "attempt-one:reconstruction-ack:ses_replacement";
    store.create(
      createRecord("project-one", "card-one", {
        phase: "implementation",
        expectedBranch: "agent/card-one",
        primarySessionId: "ses_replacement",
        sessionCreationStatus: "bound",
        primaryOperations: {
          "implementation-op": {
            id: "implementation-op",
            activity: "implementation",
            role: "primary",
            executions: 3,
            failureExecutions: 2,
            dependencyOutages: 0,
            status: "dispatched",
            lastSessionId: "ses_lost",
            updatedAt: "2026-10-24T09:00:00.000Z",
          },
          [ackId]: {
            id: ackId,
            activity: "reconstruction-acknowledgement",
            role: "reconstruction",
            executions: 1,
            failureExecutions: 1,
            status: "failed",
            retrySafe: true,
            lastSessionId: "ses_replacement",
            updatedAt: "2026-10-24T09:00:00.000Z",
          },
        },
        sessionRecovery: {
          originalSessionId: "ses_lost",
          status: "reconstruction-process-failed",
          reconstructionBaseline: recoveryBaseline(),
        },
      }),
    );
    const run = vi.fn<RunOpenCode>().mockResolvedValue({
      exitCode: 0,
      output: "ack",
      errorOutput: "",
      sessionId: "ses_replacement",
    });
    const bundle = {
      version: 1 as const,
      projectId: "project-one",
      cardId: "card-one",
      attemptId: "attempt-one",
      repositoryPath: project.repository.path,
      repositoryHead: "a".repeat(40),
      card: {
        title: "Task",
        description: "Current task",
        current: true as const,
      },
      plan: { status: "absent" as const },
      attachmentManifest: { status: "absent" as const },
      currentDiff: "preserved partial changes",
      history: "prior work",
      feedback: { status: "absent" as const, references: [] },
    };
    await expect(
      runWithPrimaryTaskSession(
        store,
        new OpenCodeClient(run),
        "project-one",
        "card-one",
        {
          ...createRunOptions("Restore continuity."),
          cwd: project.repository.path,
          readOnly: true,
        },
        {
          inspect: async () => "reachable",
          context: bundle,
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
          operationId: ackId,
          readOnlyAcknowledged: true,
          inspectOwningPrimary: async (entry) => ({
            status: "stopped-after-dispatch",
            operationId: entry.id,
            execution: entry.executions,
            sessionId: "ses_lost",
            failureClassification: "dependency-outage",
          }),
          inspectPending: async () => ({ status: "unknown" }),
        },
      ),
    ).rejects.toThrow("waiting for authoritative reconciliation");
    expect(run).not.toHaveBeenCalled();
    expect(store.read("card-one")?.primaryOperations).toMatchObject({
      "implementation-op": {
        status: "failed",
        executions: 3,
        failureExecutions: 2,
        dependencyOutages: 1,
        accountedExecution: 3,
        lastExecutionClassification: "dependency-outage",
      },
      [ackId]: { executions: 1, status: "failed" },
    });
  });

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

  it.each([
    { owningStatus: "dispatched", metadataStatus: "not-dispatched" },
    { owningStatus: "dispatched", metadataStatus: "spawn-failure" },
    { owningStatus: "ambiguous", metadataStatus: "not-dispatched" },
    { owningStatus: "ambiguous", metadataStatus: "spawn-failure" },
  ] as const)(
    "reconciles $owningStatus using persisted $metadataStatus proof before acknowledgement recovery",
    async ({ owningStatus, metadataStatus }) => {
      const { store, project, root: storeRoot } = createFixture();
      const trustedRoot = path.join(storeRoot, "artifacts");
      const artifactRoot = path.join(
        trustedRoot,
        "card-one",
        "process-executions",
      );
      const metadataPath = path.join(
        artifactRoot,
        "original-primary-execution",
        "execution.json",
      );
      fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
      const bundle = {
        version: 1 as const,
        projectId: "project-one",
        cardId: "card-one",
        attemptId: "attempt-one",
        repositoryPath: project.repository.path,
        repositoryHead: "a".repeat(40),
        card: {
          title: "Task",
          description: "Current task",
          current: true as const,
        },
        plan: { status: "absent" as const },
        attachmentManifest: { status: "absent" as const },
        currentDiff: "preserved partial changes",
        history: "prior work",
        feedback: { status: "absent" as const, references: [] },
      };
      store.create(
        createRecord("project-one", "card-one", {
          phase: "implementation",
          expectedBranch: "agent/card-one",
          primarySessionId: "ses_replacement",
          sessionCreationStatus: "bound",
          primaryOperations: {
            "implementation-op": {
              id: "implementation-op",
              activity: "implementation",
              role: "primary",
              executions: 1,
              status: owningStatus,
              lastSessionId: "ses_lost",
              processExecutionId: "original-primary-execution",
              processMetadataPath: metadataPath,
              processArtifactRoot: artifactRoot,
              updatedAt: "2026-10-24T09:00:00.000Z",
            },
            "attempt-one:reconstruction-ack:ses_replacement": {
              id: "attempt-one:reconstruction-ack:ses_replacement",
              activity: "reconstruction-acknowledgement",
              role: "reconstruction",
              executions: 1,
              failureExecutions: 1,
              status: "failed",
              retrySafe: true,
              lastSessionId: "ses_replacement",
              updatedAt: "2026-10-24T09:00:00.000Z",
            },
          },
          sessionRecovery: {
            originalSessionId: "ses_lost",
            status: "reconstruction-process-failed",
            reconstructionBaseline: recoveryBaseline(),
          },
        }),
      );
      fs.writeFileSync(
        metadataPath,
        JSON.stringify({
          executionId: "original-primary-execution",
          cwd: project.repository.path,
          status: metadataStatus,
          ...(metadataStatus === "spawn-failure"
            ? { dispatchState: "not-dispatched" }
            : {}),
        }),
      );
      const run = vi
        .fn<RunOpenCode>()
        .mockResolvedValueOnce({
          exitCode: 0,
          output: "acknowledged",
          errorOutput: "",
          sessionId: "ses_replacement",
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          output: "implementation resumed",
          errorOutput: "",
          sessionId: "ses_replacement",
        });
      const common = {
        ...createRunOptions("Restore continuity for this same task."),
        cwd: project.repository.path,
        readOnly: true,
      };
      const recovery = {
        inspect: async () => "reachable" as const,
        context: bundle,
        contextDirectory: path.join(temporaryRoot!, "recovery-context"),
        forbiddenPaths: [
          project.repository.path,
          project.repository.worktreeRoot,
        ],
        attemptId: "attempt-one",
        baseline: recoveryBaseline(),
      };
      const operationId = "attempt-one:reconstruction-ack:ses_replacement";
      await expect(
        runWithPrimaryTaskSession(
          store,
          new OpenCodeClient(run),
          "project-one",
          "card-one",
          common,
          recovery,
          {
            role: "reconstruction",
            operationId,
            readOnlyAcknowledged: true,
            inspectOwningPrimary: async () => ({ status: "unknown" }),
            inspectPending: async () => ({ status: "unknown" }),
          },
        ),
      ).rejects.toThrow("waiting for authoritative reconciliation");
      expect(run).not.toHaveBeenCalled();

      const restartedStore = new TaskExecutionStore(storeRoot, project);
      const result = await runWithPrimaryTaskSession(
        restartedStore,
        new OpenCodeClient(run),
        "project-one",
        "card-one",
        common,
        recovery,
        {
          role: "reconstruction",
          operationId,
          readOnlyAcknowledged: true,
          inspectOwningPrimary: (entry) =>
            inspectPrimaryOperationEvidence(
              restartedStore,
              "card-one",
              entry.id,
              { trustedRoot, cwd: project.repository.path },
            ),
          inspectPending: async (entry) => ({
            status: "stopped-after-dispatch",
            operationId,
            execution: entry.executions,
            sessionId: "ses_replacement",
          }),
        },
      );
      expect(result.exitCode).toBe(0);
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls.map(([options]) => options.sessionId)).toEqual([
        "ses_replacement",
      ]);
      expect(restartedStore.read("card-one")).toMatchObject({
        primarySessionId: "ses_replacement",
        primaryOperations: {
          "implementation-op": {
            executions: 0,
            failureExecutions: 0,
            status: "failed",
            retrySafe: true,
          },
          [operationId]: {
            activity: "reconstruction-acknowledgement",
            role: "reconstruction",
            executions: 2,
            status: "completed",
          },
        },
      });

      const acknowledged = restartedStore.read("card-one")!;
      restartedStore.compareAndSwap("card-one", acknowledged.revision, {
        ...acknowledged,
        sessionRecovery: {
          ...acknowledged.sessionRecovery!,
          status: "reconstruction-verified",
          reconstructionBaseline: undefined,
        },
        revision: acknowledged.revision + 1,
        updatedAt: "2026-10-24T09:00:00.001Z",
      });
      const resumed = await runWithPrimaryTaskSession(
        restartedStore,
        new OpenCodeClient(run),
        "project-one",
        "card-one",
        createRunOptions("Resume the persisted implementation operation."),
        recovery,
        {
          role: "primary",
          operationId: "implementation-op",
          activity: "implementation",
          inspectPending: async () => ({ status: "unknown" }),
        },
      );
      expect(resumed.exitCode).toBe(0);
      expect(run.mock.calls[1]?.[0]).toMatchObject({
        sessionId: "ses_replacement",
        prompt: "Resume the persisted implementation operation.",
      });
      expect(restartedStore.read("card-one")?.primaryOperations).toMatchObject({
        "implementation-op": { executions: 1, role: "primary" },
        [operationId]: { executions: 2, role: "reconstruction" },
      });
    },
  );
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
    const canaries = [
      "artifact-card-key",
      "artifact-plan-key",
      "artifact-diff-key",
      "artifact-history-key",
      "artifact-feedback-key",
    ];
    registerProcessSecrets(canaries);
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
            title: `safe card ${canaries[0]}`,
            description: "useful card description",
            current: true,
          },
          plan: {
            status: "available",
            content: JSON.stringify({ summary: `useful plan ${canaries[1]}` }),
          },
          attachmentManifest: { status: "available", content: "[]" },
          currentDiff: JSON.stringify({ diff: `useful diff ${canaries[2]}` }),
          history: JSON.stringify({ history: `useful history ${canaries[3]}` }),
          feedback: {
            status: "available",
            references: ["feedback:1"],
            content: JSON.stringify({
              entries: [
                { id: "feedback:1", text: `useful feedback ${canaries[4]}` },
              ],
            }),
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
    const saved = store.read("card-one")!.sessionRecovery!;
    const artifactBytes = fs.readFileSync(saved.contextPath!);
    expect(
      `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}`,
    ).toBe(saved.contextReference);
    const artifact = artifactBytes.toString("utf8");
    const outbound = runOpenCode.mock.calls[0]![0].prompt;
    for (const canary of canaries) {
      expect(artifact).not.toContain(canary);
      expect(outbound).not.toContain(canary);
    }
    const decoded = JSON.parse(artifact);
    expect(decoded.card.title).toContain("safe card");
    expect(JSON.parse(decoded.plan.content).summary).toContain("useful plan");
    expect(JSON.parse(decoded.currentDiff).diff).toContain("useful diff");
    expect(JSON.parse(decoded.history).history).toContain("useful history");
    expect(JSON.parse(decoded.feedback.content).entries[0].text).toContain(
      "useful feedback",
    );
    expect(outbound).toContain("useful feedback");
  });

  it("persists and dispatches sanitized builder context through canonical artifacts without changing a real Git worktree", async () => {
    const { project } = createFixture();
    const repo = project.repository.path;
    const gitRun = (args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trimEnd();
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    gitRun(["config", "user.name", "Fixture"]);
    gitRun(["config", "user.email", "fixture@example.test"]);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked original\n");
    gitRun(["add", "tracked.txt"]);
    gitRun(["commit", "-m", "fixture"]);
    fs.writeFileSync(
      path.join(repo, "untracked.txt"),
      "safe untracked fact; untracked-canary",
    );
    fs.writeFileSync(
      path.join(repo, "tracked.txt"),
      "tracked original\nstaged safe diff; diff-canary\n",
    );
    gitRun(["add", "tracked.txt"]);
    const attachmentRoot = path.join(temporaryRoot!, "external");
    const attachmentPath = path.join(
      attachmentRoot,
      "project-one",
      "card-one",
      "attachments",
      "brief.txt",
    );
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, "safe attachment fact; attachment-canary");
    const feedback = JSON.stringify({
      entries: [
        {
          id: "feedback-one",
          text: 'safe feedback; quote " slash \\\n newline-canary',
        },
      ],
    });
    const canaries = [
      "card-canary",
      "plan-canary",
      "diff-canary",
      "history-canary",
      "attachment-canary",
      "untracked-canary",
      'quote " slash \\\n newline-canary',
    ];
    registerProcessSecrets(canaries);
    const contextRoot = path.join(temporaryRoot!, "contexts");
    const gitClient = new GitClient();
    const executionRecord = {
      ...createRecord("project-one", "card-one", {
        phase: "implementation",
        expectedBranch: "agent/card-one",
        primarySessionId: "ses_lost",
        sessionCreationStatus: "bound",
        operationKey: "history-canary",
      }),
      reviewObservation: {
        headSha: gitRun(["rev-parse", "HEAD"]),
        observedAt: new Date().toISOString(),
        ciEvaluation: {
          status: "waiting",
          expectedCheckNames: [],
          missingChecks: [],
          pendingChecks: [],
          failureCheckNames: [],
        },
        feedbackIds: ["feedback-one"],
      },
    } as TaskExecutionRecord;
    const bundle = await buildPrimarySessionContext({
      git: gitClient,
      projectId: "project-one",
      card: {
        id: "card-one",
        name: "task card-canary",
        desc: "safe card fact",
        idList: "working",
        idLabels: [],
        url: "https://trello.example/card-one",
      },
      attemptId: "attempt-one",
      worktreePath: repo,
      record: executionRecord,
      plan: { summary: "safe plan fact; plan-canary" },
      feedbackContent: feedback,
      attachments: {
        contextRoot: attachmentRoot,
        projectId: "project-one",
        cardId: "card-one",
        manifest: {
          attachments: [
            {
              id: "attachment-one",
              name: "brief.txt",
              mimeType: "text/plain",
              bytes: null,
              url: "https://example.test/brief",
              isUpload: true,
              localFilename: "brief.txt",
            },
          ],
        },
      },
    });
    const coordination = path.join(temporaryRoot!, "state");
    const runStore = new RunStore(
      coordination,
      "attempt-one",
      {
        integrationId: "fixture",
        projectId: "project-one",
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
        repositoryPath: repo,
        worktreeRoot: project.repository.worktreeRoot,
        storageRoot: coordination,
      },
      {
        integrationId: "fixture",
        instanceId: "fixture-instance",
        token: "fixture-token",
        assertHeld: () => undefined,
      },
    );
    runStore.create({
      version: 1,
      revision: 1,
      projectId: "project-one",
      cardId: "card-one",
      attemptId: "attempt-one",
      taskKind: "implementation",
      pinned: {
        integrationId: "fixture",
        projectId: "project-one",
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
        repositoryPath: repo,
        worktreeRoot: project.repository.worktreeRoot,
        storageRoot: coordination,
      },
      lifecycle: "implementation",
      checkpoint: "implementation",
      publicationState: "none",
      operation: { id: null, kind: null, generation: 0 },
      wait: { reason: null, dependency: null, since: null, retryAt: null },
      owner: {
        instanceId: "fixture-instance",
        token: "fixture-token",
        generation: 1,
      },
      resources: [],
      pendingOperations: [],
      queue: [],
      budgets: {},
      sessions: {},
      artifacts: [],
      expectedTrelloListId: null,
      terminalSync: "not-applicable",
      terminalEvidence: null,
      legacy: {},
      compatibility: {},
      updatedAt: new Date().toISOString(),
    });
    const authority = new ProjectRunAuthority("project-one", runStore, 1);
    const artifactStore = new TaskExecutionStore(
      coordination,
      project,
      authority,
    );
    const persistedRecord = { ...executionRecord };
    delete persistedRecord.reviewObservation;
    artifactStore.create(persistedRecord as TaskExecutionRecord);
    const fingerprint = () =>
      JSON.stringify({
        head: gitRun(["rev-parse", "HEAD"]),
        status: gitRun(["status", "--porcelain=v1", "-uall"]),
        index: gitRun(["ls-files", "--stage"]),
        refs: gitRun(["for-each-ref", "--format=%(refname) %(objectname)"]),
        tracked: fs.readFileSync(path.join(repo, "tracked.txt")),
        untracked: fs.readFileSync(path.join(repo, "untracked.txt")),
      });
    const before = fingerprint();
    const actualBaseline = {
      sourceIdentity: await getTaskSessionSourceSnapshotIdentity(
        gitClient,
        repo,
      ),
      head: gitRun(["rev-parse", "HEAD"]),
      branch: gitRun(["branch", "--show-current"]),
      branchRef: gitRun(["rev-parse", "HEAD"]),
      refsIdentity: createHash("sha256")
        .update(gitRun(["for-each-ref", "--format=%(refname) %(objectname)"]))
        .digest("hex"),
    };
    const run = vi.fn<RunOpenCode>().mockResolvedValue({
      exitCode: 0,
      output: sessionEvent("ses_replacement"),
      errorOutput: "",
    });
    await runWithPrimaryTaskSession(
      artifactStore,
      new OpenCodeClient(run),
      "project-one",
      "card-one",
      { ...createRunOptions(), cwd: repo, readOnly: true },
      {
        inspect: async () => "confirmed-absent",
        context: bundle,
        contextDirectory: contextRoot,
        forbiddenPaths: [repo, project.repository.worktreeRoot],
        attemptId: "attempt-one",
        baseline: actualBaseline,
        persistArtifact: (content) => {
          const artifact = runStore.writeArtifact(content, "application/json");
          return { reference: artifact.id, path: artifact.path };
        },
      },
      {
        role: "reconstruction",
        operationId: "attempt-one:reconstruction",
        readOnlyAcknowledged: true,
      },
    );
    expect(fingerprint()).toBe(before);
    const recovery = artifactStore.read("card-one")!.sessionRecovery!;
    const stored = fs.readFileSync(recovery.contextPath!);
    expect(`sha256:${createHash("sha256").update(stored).digest("hex")}`).toBe(
      recovery.contextReference,
    );
    const parsed = JSON.parse(stored.toString("utf8"));
    const outbound = run.mock.calls[0]![0].prompt;
    for (const secret of canaries) {
      expect(stored.toString("utf8")).not.toContain(secret);
      expect(outbound).not.toContain(secret);
    }
    expect(parsed.plan.content).toContain("safe plan fact");
    expect(parsed.attachmentManifest.content).toContain("safe attachment fact");
    expect(JSON.parse(parsed.feedback.content).entries[0].text).toContain(
      "safe feedback",
    );
    const history = JSON.parse(parsed.history);
    const ledger = JSON.parse(history.feedbackLedger);
    expect(ledger.entries[0].text).not.toContain(canaries[6]);
    expect(ledger.entries[0].text).toContain("safe feedback");
    expect(
      Buffer.from(
        JSON.parse(parsed.currentDiff).untracked[0].contentBase64,
        "base64",
      ).toString(),
    ).toContain("safe untracked fact");
    expect(outbound).toContain("safe card fact");
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
