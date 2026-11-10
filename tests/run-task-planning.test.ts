import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import type { CardAttachmentPromptContext } from "../src/context/card-attachment-prompt.js";
import type { CardAttachmentManifest } from "../src/context/materialize-card-attachments.js";
import {
  OpenCodeClient,
  OpenCodeTimeoutError,
  type RunOpenCode,
} from "../src/opencode/opencode-client.js";
import { buildTaskPlanningPrompt } from "../src/opencode/build-task-planning-prompt.js";
import {
  runTaskPlanningOperation,
  TaskClarificationRequiredError,
} from "../src/task-session/run-task-planning.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import type { PrimaryOperationEntry } from "../src/task-session/run-primary-operation.js";
import { TaskPlanStore } from "../src/task-session/task-plan-store.js";
import {
  parseTaskPlanningResult,
  type TaskPlan,
} from "../src/task-session/task-plan.js";
import type {
  TrelloAttachment,
  TrelloCard,
} from "../src/trello/trello-client.js";

let temporaryRoot: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();

  if (temporaryRoot !== undefined) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

const projectId = "project-one";
const card: TrelloCard = {
  id: "card-one",
  name: "Add a settings page",
  desc: "Create a settings page that persists the user's preferences.",
  idList: "ready-list",
  idLabels: ["feature-label"],
  url: "https://trello.example/card-one",
};

const attachments: TrelloAttachment[] = [
  {
    id: "upload-one",
    name: "acceptance.md",
    mimeType: "text/markdown",
    bytes: "34",
    url: "https://trello.example/private-upload-url",
    isUpload: true,
  },
  {
    id: "link-one",
    name: "Design reference",
    mimeType: null,
    bytes: null,
    url: "https://example.com/settings-design",
    isUpload: false,
  },
];

const validPlan: TaskPlan = {
  version: 1,
  projectId,
  cardId: card.id,
  requirements: [
    {
      id: "REQ-1",
      text: "Persist the user's settings.",
      verification: "Add a test that reloads saved preferences.",
    },
  ],
  steps: [
    {
      id: "STEP-1",
      description: "Implement the settings page and persistence.",
      requirementIds: ["REQ-1"],
      verification: "Run the settings tests.",
    },
  ],
  assumptions: [],
  blockers: [],
};

afterEach(() => {
  if (temporaryRoot !== undefined) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

function createFixture(): {
  attachmentContext: CardAttachmentPromptContext;
  executionStore: TaskExecutionStore;
  planStore: TaskPlanStore;
  project: ProjectConfig;
  repositoryPath: string;
  worktreePath: string;
} {
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-task-planning-"),
  );
  const repositoryPath = path.join(temporaryRoot, "repository");
  const worktreeRoot = path.join(temporaryRoot, "worktrees");
  const worktreePath = path.join(worktreeRoot, card.id);
  const contextRoot = path.join(temporaryRoot, "card-context");
  const attachmentPath = path.join(
    contextRoot,
    projectId,
    card.id,
    "attachments",
    "acceptance.md",
  );
  fs.mkdirSync(repositoryPath);
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
  fs.writeFileSync(
    repositoryPath + path.sep + "sentinel.txt",
    "unchanged",
    "utf8",
  );
  fs.writeFileSync(attachmentPath, "The settings must persist.", "utf8");

  const project = {
    id: projectId,
    repository: { path: repositoryPath, worktreeRoot },
  } as ProjectConfig;
  const storageRoot = path.join(temporaryRoot, "runtime-state");
  const executionStore = new TaskExecutionStore(storageRoot, project);
  const planStore = new TaskPlanStore(storageRoot, project);
  executionStore.create({
    version: 1,
    projectId,
    cardId: card.id,
    phase: "planning",
    operationKey: "initial-plan",
    revision: 1,
    retryCounters: {
      validation: 0,
      review: 0,
      ci: 0,
      humanFeedback: 0,
    },
    createdAt: "2026-10-24T09:00:00.000Z",
    updatedAt: "2026-10-24T09:00:00.000Z",
  });

  const manifest: CardAttachmentManifest = {
    attachments: [
      {
        id: "upload-one",
        name: "acceptance.md",
        mimeType: "text/markdown",
        bytes: "34",
        url: "https://trello.example/private-upload-url",
        isUpload: true,
        localFilename: "acceptance.md",
      },
      {
        id: "link-one",
        name: "Design reference",
        mimeType: null,
        bytes: null,
        url: "https://example.com/settings-design",
        isUpload: false,
        localFilename: null,
      },
    ],
  };
  const attachmentContext: CardAttachmentPromptContext = {
    manifest,
    contextRoot,
    projectId,
    cardId: card.id,
  };

  return {
    attachmentContext,
    executionStore,
    planStore,
    project,
    repositoryPath,
    worktreePath,
  };
}

function structuredPlanningOutput(
  planText: string,
  sessionId = "ses_planning-one",
): string {
  return [
    JSON.stringify({ type: "step_start", sessionID: sessionId }),
    JSON.stringify({
      type: "text",
      sessionID: sessionId,
      part: { type: "text", text: planText },
    }),
  ].join("\n");
}

function createRunOpenCode(
  planText: string,
): ReturnType<typeof vi.fn<RunOpenCode>> {
  return vi.fn<RunOpenCode>().mockResolvedValue({
    exitCode: 0,
    output: structuredPlanningOutput(planText),
    errorOutput: "",
  });
}

describe("buildTaskPlanningPrompt", () => {
  it("includes the original task, attachment metadata, instructions, and only-plan contract", () => {
    const { attachmentContext } = createFixture();

    try {
      const prompt = buildTaskPlanningPrompt(
        projectId,
        card,
        attachments,
        attachmentContext,
      );

      expect(prompt).toContain(
        'Task identity: {"projectId":"project-one","cardId":"card-one"}',
      );
      expect(prompt).toContain(card.name);
      expect(prompt).toContain(card.desc);
      expect(prompt).toContain("AGENTS.md");
      expect(prompt).toContain("Trello card attachments:");
      expect(prompt).toContain("local file:");
      expect(prompt).toContain("https://example.com/settings-design");
      expect(prompt).toContain("upload-one");
      expect(prompt).not.toContain("private-upload-url");
      expect(prompt).toContain('"requirements"');
      expect(prompt).toContain('"requirementIds"');
      expect(prompt).toContain("Do not implement the task");
      expect(prompt).toContain("Do not modify repository files");
    } finally {
      fs.rmSync(temporaryRoot!, { recursive: true, force: true });
      temporaryRoot = undefined;
    }
  });

  it("rejects attachment context associated with a different card", () => {
    const { attachmentContext } = createFixture();

    try {
      expect(() =>
        buildTaskPlanningPrompt(projectId, card, attachments, {
          ...attachmentContext,
          cardId: "another-card",
        }),
      ).toThrow("does not match the task project and card");
    } finally {
      fs.rmSync(temporaryRoot!, { recursive: true, force: true });
      temporaryRoot = undefined;
    }
  });
});

describe("runTaskPlanningOperation", () => {
  it("recovers a bound planning timeout from verified stop evidence and does not rerun saved advice after restart", async () => {
    const fixture = createFixture();
    const initial = fixture.executionStore.read(card.id);
    if (initial === null) throw new Error("Expected task execution record");
    fixture.executionStore.compareAndSwap(card.id, initial.revision, {
      ...initial,
      primarySessionId: "ses_planning-one",
      sessionCreationStatus: "bound",
      revision: initial.revision + 1,
      updatedAt: "2026-10-24T09:01:00.000Z",
    });
    const runOpenCode = vi
      .fn<RunOpenCode>()
      .mockRejectedValueOnce(
        new OpenCodeTimeoutError(100, "planning-timeout", true),
      )
      .mockResolvedValueOnce({
        exitCode: 0,
        output: structuredPlanningOutput(JSON.stringify(validPlan)),
        errorOutput: "",
        sessionId: "ses_planning-one",
      });
    const operationId = "initial-plan:planning";
    const operation = {
      operationId,
      trustedRoot: path.join(temporaryRoot!, "runtime-state"),
      cwd: fixture.worktreePath,
      inspectPending: async (entry: PrimaryOperationEntry) => ({
        status: "stopped-after-dispatch" as const,
        operationId: entry.id,
        execution: entry.executions,
        ...(entry.lastSessionId === undefined
          ? {}
          : { sessionId: entry.lastSessionId }),
      }),
    };

    const result = await runTaskPlanningOperation({
      taskRecordStore: fixture.executionStore,
      planStore: fixture.planStore,
      openCode: new OpenCodeClient(runOpenCode),
      projectId,
      card,
      runOptions: {
        cwd: fixture.worktreePath,
        timeoutMilliseconds: 100,
        signal: new AbortController().signal,
      },
      primaryOperation: operation,
    });

    expect(result.plan).toEqual(validPlan);
    expect(runOpenCode).toHaveBeenCalledTimes(2);
    expect(
      fixture.executionStore.read(card.id)?.primaryOperations,
    ).toMatchObject({
      [operationId]: { role: "advisory", executions: 2, status: "completed" },
    });
    const restartedStore = new TaskExecutionStore(
      path.join(temporaryRoot!, "runtime-state"),
      fixture.project,
    );
    const restartedPlanStore = new TaskPlanStore(
      path.join(temporaryRoot!, "runtime-state"),
      fixture.project,
    );
    await expect(
      runTaskPlanningOperation({
        taskRecordStore: restartedStore,
        planStore: restartedPlanStore,
        openCode: new OpenCodeClient(runOpenCode),
        projectId,
        card,
        runOptions: {
          cwd: fixture.worktreePath,
          timeoutMilliseconds: 100,
          signal: new AbortController().signal,
        },
        primaryOperation: operation,
      }),
    ).rejects.toThrow("refusing to replace it");
    expect(runOpenCode).toHaveBeenCalledTimes(2);
  });

  it("accepts only an authenticated, evidence-backed actionable clarification and leaves planning unadvanced", async () => {
    const fixture = createFixture();
    const clarification = {
      version: 1,
      outcome: "clarification-required",
      projectId,
      cardId: card.id,
      evidenceExamined: [
        "Read the card description and searched the repository for existing preference persistence",
        "Read acceptance.md attachment context",
      ],
      reason:
        "The task does not say whether preferences are per-user or shared.",
      questions: [
        "Should preferences be isolated per account or shared across all users?",
      ],
    };
    expect(parseTaskPlanningResult(clarification)).toEqual(clarification);
    expect(() =>
      parseTaskPlanningResult({ ...clarification, cardId: "" }),
    ).toThrow();
    expect(() =>
      parseTaskPlanningResult({ ...clarification, questions: [] }),
    ).toThrow();
    expect(() =>
      parseTaskPlanningResult({ ...clarification, surprise: true }),
    ).toThrow();

    await expect(
      runTaskPlanningOperation({
        taskRecordStore: fixture.executionStore,
        planStore: fixture.planStore,
        openCode: new OpenCodeClient(
          createRunOpenCode(JSON.stringify(clarification)),
        ),
        projectId,
        card,
        attachments,
        attachmentContext: fixture.attachmentContext,
        runOptions: {
          cwd: fixture.worktreePath,
          timeoutMilliseconds: 60_000,
          signal: new AbortController().signal,
        },
      }),
    ).rejects.toBeInstanceOf(TaskClarificationRequiredError);
    expect(fixture.planStore.read(card.id)).toBeNull();
    expect(fixture.executionStore.read(card.id)).toMatchObject({
      phase: "planning",
      sessionCreationStatus: "bound",
    });
  });

  it("keeps an understandable plan with blockers as a plan instead of inferring clarification", () => {
    const plan = {
      ...validPlan,
      blockers: ["Independent review may still identify a quality concern."],
    };
    expect(parseTaskPlanningResult(plan)).toEqual(plan);
  });

  it("runs the primary planning session, validates, and stores only its plan artifact", async () => {
    const fixture = createFixture();
    const runOpenCode = createRunOpenCode(JSON.stringify(validPlan));
    const sentinelPath = path.join(fixture.repositoryPath, "sentinel.txt");
    const sentinelBefore = fs.readFileSync(sentinelPath, "utf8");

    const result = await runTaskPlanningOperation({
      taskRecordStore: fixture.executionStore,
      planStore: fixture.planStore,
      openCode: new OpenCodeClient(runOpenCode),
      projectId,
      card,
      attachments,
      attachmentContext: fixture.attachmentContext,
      runOptions: {
        cwd: fixture.worktreePath,
        model: "planning-model",
        variant: "high",
        timeoutMilliseconds: 60_000,
        signal: new AbortController().signal,
      },
    });

    expect(result.plan).toEqual(validPlan);
    expect(result.storedPlan).toMatchObject({
      planRevision: 1,
      taskRecordRevision: 3,
      plan: validPlan,
    });
    expect(fixture.planStore.read(card.id, 3)?.plan).toEqual(validPlan);
    expect(fixture.executionStore.read(card.id)).toMatchObject({
      phase: "planning",
      sessionCreationStatus: "bound",
      primarySessionId: "ses_planning-one",
    });
    expect(runOpenCode).toHaveBeenCalledOnce();
    expect(runOpenCode.mock.calls[0]?.[0]).toMatchObject({
      captureSessionId: true,
      cwd: fixture.worktreePath,
    });
    expect(runOpenCode.mock.calls[0]?.[0].prompt).toContain(card.name);
    expect(runOpenCode.mock.calls[0]?.[0].prompt).toContain("acceptance.md");
    expect(fs.readFileSync(sentinelPath, "utf8")).toBe(sentinelBefore);
  });

  it("rejects malformed plan JSON without saving a plan or advancing the phase", async () => {
    const fixture = createFixture();
    const runOpenCode = createRunOpenCode('{"version":1,"requirements":');

    await expect(
      runTaskPlanningOperation({
        taskRecordStore: fixture.executionStore,
        planStore: fixture.planStore,
        openCode: new OpenCodeClient(runOpenCode),
        projectId,
        card,
        runOptions: {
          cwd: fixture.worktreePath,
          model: "planning-model",
          variant: "high",
          timeoutMilliseconds: 60_000,
          signal: new AbortController().signal,
        },
      }),
    ).rejects.toMatchObject({
      name: "TaskPlanningOperationError",
      runResult: expect.objectContaining({ errorOutput: "" }),
    });

    expect(fixture.planStore.read(card.id)).toBeNull();
    expect(fixture.executionStore.read(card.id)).toMatchObject({
      phase: "planning",
      sessionCreationStatus: "bound",
    });
  });

  it("rejects a structurally invalid plan artifact", async () => {
    const fixture = createFixture();
    const runOpenCode = createRunOpenCode(
      JSON.stringify({ ...validPlan, steps: [] }),
    );

    await expect(
      runTaskPlanningOperation({
        taskRecordStore: fixture.executionStore,
        planStore: fixture.planStore,
        openCode: new OpenCodeClient(runOpenCode),
        projectId,
        card,
        runOptions: {
          cwd: fixture.worktreePath,
          model: "planning-model",
          variant: "high",
          timeoutMilliseconds: 60_000,
          signal: new AbortController().signal,
        },
      }),
    ).rejects.toThrow("Could not parse and validate");

    expect(fixture.planStore.read(card.id)).toBeNull();
    expect(fixture.executionStore.read(card.id)?.phase).toBe("planning");
  });

  it("rejects a valid plan for the wrong card without saving it", async () => {
    const fixture = createFixture();
    const runOpenCode = createRunOpenCode(
      JSON.stringify({ ...validPlan, cardId: "another-card" }),
    );

    await expect(
      runTaskPlanningOperation({
        taskRecordStore: fixture.executionStore,
        planStore: fixture.planStore,
        openCode: new OpenCodeClient(runOpenCode),
        projectId,
        card,
        runOptions: {
          cwd: fixture.worktreePath,
          model: "planning-model",
          variant: "high",
          timeoutMilliseconds: 60_000,
          signal: new AbortController().signal,
        },
      }),
    ).rejects.toThrow("identity does not match");
    expect(fixture.planStore.read(card.id)).toBeNull();
  });

  it("does not overwrite an already persisted plan or invoke OpenCode", async () => {
    const fixture = createFixture();
    fixture.planStore.create(validPlan, 1);
    const runOpenCode = vi.fn<RunOpenCode>();

    await expect(
      runTaskPlanningOperation({
        taskRecordStore: fixture.executionStore,
        planStore: fixture.planStore,
        openCode: new OpenCodeClient(runOpenCode),
        projectId,
        card,
        runOptions: {
          cwd: fixture.worktreePath,
          model: "planning-model",
          variant: "high",
          timeoutMilliseconds: 60_000,
          signal: new AbortController().signal,
        },
      }),
    ).rejects.toThrow("refusing to replace it");
    expect(runOpenCode).not.toHaveBeenCalled();
  });
});
