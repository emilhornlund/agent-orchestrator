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
import { runWithPrimaryTaskSession } from "../src/task-session/primary-task-session.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import type { TaskExecutionRecord } from "../src/task-session/task-execution-record.js";

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

describe("runWithPrimaryTaskSession", () => {
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
      createRunOptions(),
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
