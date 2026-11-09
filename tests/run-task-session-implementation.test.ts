import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import { CommandRunner } from "../src/process/command-runner.js";
import {
  OpenCodeClient,
  OpenCodeRunAbortedError,
  type RunOpenCode,
} from "../src/opencode/opencode-client.js";
import { runTaskSessionImplementation } from "../src/task-session/run-task-session-implementation.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { TaskPlanStore } from "../src/task-session/task-plan-store.js";
import type { TaskPlan } from "../src/task-session/task-plan.js";
import type { PlanVerificationResult } from "../src/task-session/plan-verification.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

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
  name: "Implement the requested feature",
  desc: "Preserve the original request while implementing the feature.",
  idList: "ready-list",
  idLabels: [],
  url: "https://trello.example/card-one",
};
const expectedBranch = "agent/card-one";
const operationKey = "implementation-operation-one";

const plan: TaskPlan = {
  version: 1,
  projectId,
  cardId: card.id,
  requirements: [
    {
      id: "REQ-1",
      text: "Implement the requested behavior.",
      verification: "Add and run a focused test.",
    },
  ],
  steps: [
    {
      id: "STEP-1",
      description: "Implement the behavior and its test.",
      requirementIds: ["REQ-1"],
      verification: "Run the focused test suite.",
    },
  ],
  assumptions: [],
  blockers: [],
};

function createFixture(
  options: { includePlan?: boolean; legacyPlan?: boolean } = {},
) {
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-implementation-runner-"),
  );
  const repositoryPath = path.join(temporaryRoot, "repository");
  const worktreeRoot = path.join(temporaryRoot, "worktrees");
  const worktreePath = path.join(worktreeRoot, card.id);
  const storageRoot = path.join(temporaryRoot, "runtime-state");
  fs.mkdirSync(repositoryPath);
  fs.mkdirSync(worktreePath, { recursive: true });
  const repositorySentinel = path.join(repositoryPath, "source.txt");
  const worktreeSentinel = path.join(worktreePath, "agent-work.txt");
  fs.writeFileSync(repositorySentinel, "source-checkout-unchanged", "utf8");
  fs.writeFileSync(worktreeSentinel, "owned-worktree-preserved", "utf8");

  const project = {
    id: projectId,
    repository: {
      path: repositoryPath,
      worktreeRoot,
      validationCommand: "yarn validate",
    },
  } as ProjectConfig;
  const taskRecordStore = new TaskExecutionStore(storageRoot, project);
  const planStore = new TaskPlanStore(storageRoot, project);
  taskRecordStore.create({
    version: 1,
    projectId,
    cardId: card.id,
    phase: "planning",
    primarySessionId: "ses_primary-task-session",
    sessionCreationStatus: "bound",
    expectedBranch,
    operationKey,
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

  if (options.includePlan !== false) {
    planStore.create(
      plan,
      1,
      options.legacyPlan === true ? undefined : operationKey,
    );
    planStore.storeVerification(card.id, 1, {
      version: 1,
      projectId,
      cardId: card.id,
      planRevision: 1,
      verdict: "pass",
      findings: [],
    } satisfies PlanVerificationResult);
  }

  const getCurrentBranch = vi.fn(async () => expectedBranch);
  const runOpenCode = vi.fn<RunOpenCode>().mockResolvedValue({
    exitCode: 0,
    output: "implementation complete",
    errorOutput: "",
  });

  return {
    project,
    planStore,
    taskRecordStore,
    worktreePath,
    repositorySentinel,
    worktreeSentinel,
    git: { getCurrentBranch } as Pick<GitClient, "getCurrentBranch">,
    getCurrentBranch,
    runOpenCode,
    openCode: new OpenCodeClient(runOpenCode),
  };
}

function runImplementation(
  fixture: ReturnType<typeof createFixture>,
  worktreePath = fixture.worktreePath,
  project = fixture.project,
) {
  return runTaskSessionImplementation({
    taskRecordStore: fixture.taskRecordStore,
    planStore: fixture.planStore,
    git: fixture.git,
    recoveryGit: {
      getHeadSha: async () => "a".repeat(40),
      getDiff: async () => "diff",
      getStatus: async () => "",
      getIndexEntries: async () => "",
      getUntrackedFiles: async () => [],
      getHeadTrackedFiles: async () => [],
    } as Pick<
      GitClient,
      | "getHeadSha"
      | "getDiff"
      | "getStatus"
      | "getIndexEntries"
      | "getUntrackedFiles"
      | "getHeadTrackedFiles"
    >,
    commands: new CommandRunner(async () => ({
      exitCode: 0,
      output: JSON.stringify([
        { id: "ses_primary-task-session", directory: worktreePath },
      ]),
    })),
    recoveryContextRoot: path.join(
      path.dirname(path.dirname(fixture.worktreePath)),
      "external-context",
    ),
    openCode: fixture.openCode,
    project,
    card,
    expectedBranch,
    operationKey,
    retryIntervalMs: 1_000,
    worktreePath,
    runOptions: {
      model: "implementation-model",
      variant: "xhigh",
      timeoutMilliseconds: 60_000,
      signal: new AbortController().signal,
    },
  });
}

describe("runTaskSessionImplementation", () => {
  it("allows implementation when no optional quality command is configured", async () => {
    const fixture = createFixture();
    const projectWithoutValidation = {
      ...fixture.project,
      repository: {
        path: fixture.project.repository.path,
        worktreeRoot: fixture.project.repository.worktreeRoot,
      },
    } as ProjectConfig;

    const result = await runImplementation(
      fixture,
      fixture.worktreePath,
      projectWithoutValidation,
    );
    expect(fixture.getCurrentBranch).toHaveBeenCalledWith(fixture.worktreePath);
    expect(fixture.runOpenCode).toHaveBeenCalledOnce();
    expect(result.record.phase).toBe("validation");
  });

  it("runs the verified plan in the owned worktree through the bound primary session", async () => {
    const fixture = createFixture();
    const result = await runImplementation(fixture);

    expect(fixture.getCurrentBranch).toHaveBeenCalledWith(fixture.worktreePath);
    expect(fixture.runOpenCode).toHaveBeenCalledOnce();
    expect(fixture.runOpenCode.mock.calls[0]?.[0]).toMatchObject({
      cwd: fixture.worktreePath,
      sessionId: "ses_primary-task-session",
      model: "implementation-model",
    });
    expect(
      fixture.runOpenCode.mock.calls[0]?.[0].captureSessionId,
    ).toBeUndefined();
    expect(fixture.runOpenCode.mock.calls[0]?.[0].prompt).toContain(
      "Task plan (advisory; may be absent):",
    );
    expect(fixture.runOpenCode.mock.calls[0]?.[0].prompt).toContain(card.desc);
    expect(fixture.runOpenCode.mock.calls[0]?.[0].prompt).toContain(
      "Do not run Git commands or invoke GitHub tools",
    );
    expect(result.record.phase).toBe("validation");
    expect(result.record.lastEvent?.type).toBe("implementation-completed");
    expect(fixture.taskRecordStore.read(card.id)?.phase).toBe("validation");
    expect(fs.readFileSync(fixture.repositorySentinel, "utf8")).toBe(
      "source-checkout-unchanged",
    );
    expect(fs.readFileSync(fixture.worktreeSentinel, "utf8")).toBe(
      "owned-worktree-preserved",
    );
  });

  it("continues from the original task when planning advice is missing or rejected", async () => {
    const missingPlanFixture = createFixture({ includePlan: false });

    await runImplementation(missingPlanFixture);
    expect(missingPlanFixture.runOpenCode).toHaveBeenCalledOnce();
    expect(missingPlanFixture.runOpenCode.mock.calls[0]?.[0].prompt).toContain(
      "No usable plan was available.",
    );
    expect(missingPlanFixture.taskRecordStore.read(card.id)?.phase).toBe(
      "validation",
    );

    const unverifiedFixture = createFixture();
    const reviewFinding = "The plan omitted the required export format choice.";
    unverifiedFixture.planStore.storeVerification(card.id, 1, {
      version: 1,
      projectId,
      cardId: card.id,
      planRevision: 1,
      verdict: "fail",
      findings: [
        {
          kind: "missing-requirement",
          requirementId: "REQ-1",
          detail: reviewFinding,
        },
      ],
    });

    await runImplementation(unverifiedFixture);
    expect(unverifiedFixture.runOpenCode).toHaveBeenCalledOnce();
    expect(unverifiedFixture.runOpenCode.mock.calls[0]?.[0].prompt).toContain(
      "Independent plan-review recommendations (advisory only; no approval is required):",
    );
    expect(unverifiedFixture.runOpenCode.mock.calls[0]?.[0].prompt).toContain(
      reviewFinding,
    );
    expect(unverifiedFixture.runOpenCode.mock.calls[0]?.[0].prompt).toContain(
      "They are not approval requirements",
    );
    expect(unverifiedFixture.taskRecordStore.read(card.id)?.phase).toBe(
      "validation",
    );
  });

  it("continues after a durably recorded plan-review failure without invalidating its plan", async () => {
    const fixture = createFixture();
    const record = fixture.taskRecordStore.read(card.id);
    if (record === null) throw new Error("Expected task execution record");
    fixture.taskRecordStore.compareAndSwap(card.id, record.revision, {
      ...record,
      planReviewAdvice: {
        status: "completed",
        diagnostic: "Plan review returned fail",
        planRevision: 1,
        taskRecordRevision: 1,
        operationKey,
      },
      revision: record.revision + 1,
      updatedAt: "2026-10-24T09:01:00.000Z",
    });

    await runImplementation(fixture);

    expect(fixture.runOpenCode).toHaveBeenCalledOnce();
    expect(fixture.taskRecordStore.read(card.id)?.phase).toBe("validation");
  });

  it("resumes the same planned task after an intervening recovery wait", async () => {
    const fixture = createFixture({ legacyPlan: true });
    const record = fixture.taskRecordStore.read(card.id);
    if (record === null) throw new Error("Expected task execution record");
    fixture.taskRecordStore.compareAndSwap(card.id, record.revision, {
      ...record,
      planReviewAdvice: {
        status: "completed",
        diagnostic: "Plan review returned fail",
        planRevision: 1,
        taskRecordRevision: 1,
        operationKey,
      },
      recoveryWait: {
        kind: "dependency",
        reason: "temporary-context-outage",
        resumePhase: "planning",
        since: "2026-10-24T09:01:00.000Z",
        retryAt: "2026-10-24T09:02:00.000Z",
        attempts: 1,
        notificationId: "planning-context-wait",
      },
      revision: record.revision + 1,
      updatedAt: "2026-10-24T09:01:00.000Z",
    });
    const savedReview = fixture.planStore.read(card.id)?.verification;

    await runImplementation(fixture);

    expect(fixture.taskRecordStore.read(card.id)?.phase).toBe("validation");
    expect(
      fixture.taskRecordStore.read(card.id)?.planReviewAdvice,
    ).toMatchObject({
      planRevision: 1,
      taskRecordRevision: 1,
      operationKey,
    });
    expect(fixture.planStore.read(card.id)?.verification).toEqual(savedReview);
    expect(fixture.runOpenCode).toHaveBeenCalledOnce();
  });

  it("refuses a plan associated with an earlier task-record revision", async () => {
    const fixture = createFixture({ legacyPlan: true });
    const current = fixture.taskRecordStore.read(card.id);

    if (current === null) {
      throw new Error("Expected task execution record");
    }

    fixture.taskRecordStore.compareAndSwap(card.id, current.revision, {
      ...current,
      revision: current.revision + 1,
      updatedAt: "2026-10-24T09:01:00.000Z",
    });

    await expect(runImplementation(fixture)).rejects.toThrow(
      "associated with task record revision",
    );
    expect(fixture.runOpenCode).not.toHaveBeenCalled();
  });

  it("refuses a worktree outside the owned root or inside the source checkout", async () => {
    const fixture = createFixture();

    await expect(
      runImplementation(fixture, fixture.project.repository.path),
    ).rejects.toThrow("outside the source checkout");
    await expect(
      runImplementation(fixture, path.join(temporaryRoot!, "unowned-worktree")),
    ).rejects.toThrow("outside the source checkout");
    expect(fixture.getCurrentBranch).not.toHaveBeenCalled();
    expect(fixture.runOpenCode).not.toHaveBeenCalled();
  });

  it("refuses a branch mismatch without running implementation", async () => {
    const fixture = createFixture();
    fixture.getCurrentBranch.mockResolvedValue("agent/another-card");

    await expect(runImplementation(fixture)).rejects.toThrow("branch mismatch");
    expect(fixture.runOpenCode).not.toHaveBeenCalled();
    expect(fixture.taskRecordStore.read(card.id)?.phase).toBe("planning");
  });

  it("preserves partial work and waits when a nonzero result lacks authoritative process evidence", async () => {
    const fixture = createFixture();
    fixture.runOpenCode.mockResolvedValue({
      exitCode: 1,
      output: "partial implementation output",
      errorOutput: "agent failed",
    });

    await expect(runImplementation(fixture)).rejects.toMatchObject({
      name: "TaskSessionImplementationWaitingError",
    });
    expect(fixture.taskRecordStore.read(card.id)).toMatchObject({
      phase: "implementation",
      recoveryWait: { resumePhase: "implementation", kind: "dependency" },
    });
    expect(
      fixture.taskRecordStore.read(card.id)?.primaryOperations?.[
        `${operationKey}:implementation`
      ]?.executions,
    ).toBe(1);
    expect(fs.readFileSync(fixture.repositorySentinel, "utf8")).toBe(
      "source-checkout-unchanged",
    );
    expect(fs.readFileSync(fixture.worktreeSentinel, "utf8")).toBe(
      "owned-worktree-preserved",
    );
  });

  it("preserves an aborted implementation phase for restart recovery without cleanup", async () => {
    const fixture = createFixture();
    fixture.runOpenCode.mockRejectedValue(new OpenCodeRunAbortedError());

    await expect(runImplementation(fixture)).rejects.toMatchObject({
      name: "TaskSessionImplementationError",
      outcome: "aborted",
    });
    expect(fixture.taskRecordStore.read(card.id)).toMatchObject({
      phase: "implementation",
      primarySessionId: "ses_primary-task-session",
    });
    expect(fs.existsSync(fixture.worktreePath)).toBe(true);
    expect(fixture.runOpenCode).toHaveBeenCalledOnce();
  });
});
