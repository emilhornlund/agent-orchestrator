import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import {
  OpenCodeClient,
  type RunOpenCode,
} from "../src/opencode/opencode-client.js";
import {
  MAX_VALIDATION_REPAIR_ATTEMPTS,
  runTaskSessionValidationWithRepairs,
  StaleTaskSessionValidationEvidenceError,
} from "../src/task-session/run-task-session-validation-repairs.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { transitionTaskExecutionRecord } from "../src/task-session/task-execution-transition.js";
import { TaskPlanStore } from "../src/task-session/task-plan-store.js";
import type { TaskPlan } from "../src/task-session/task-plan.js";
import type { RunCommand } from "../src/process/command-runner.js";
import { CommandRunner } from "../src/process/command-runner.js";
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
  name: "Add a durable settings page",
  desc: "Settings are saved and restored for the current user.",
  idList: "working-list",
  idLabels: ["feature-label"],
  url: "https://trello.example/card-one",
};
const expectedBranch = "agent/card-one";
const operationKey = "validation-cycle-one";
const primarySessionId = "ses_primary-task-session";

const plan: TaskPlan = {
  version: 1,
  projectId,
  cardId: card.id,
  requirements: [
    {
      id: "REQ-1",
      text: "Persist user settings.",
      verification: "Reload saved preferences in a test.",
    },
  ],
  steps: [
    {
      id: "STEP-1",
      description: "Implement settings persistence.",
      requirementIds: ["REQ-1"],
      verification: "Run focused settings tests.",
    },
  ],
  assumptions: [],
  blockers: [],
};

function createFixture(): {
  project: ProjectConfig;
  worktreePath: string;
  executionStore: TaskExecutionStore;
  planStore: TaskPlanStore;
  commands: CommandRunner;
  runCommand: ReturnType<typeof vi.fn<RunCommand>>;
  openCode: OpenCodeClient;
  runOpenCode: ReturnType<typeof vi.fn<RunOpenCode>>;
  git: Pick<
    GitClient,
    | "getCurrentBranch"
    | "getHeadSha"
    | "getHeadTrackedFiles"
    | "getIndexEntries"
    | "getUntrackedFiles"
  >;
  setHeadSha: (sha: string) => void;
} {
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-validation-repairs-"),
  );
  const repositoryPath = path.join(temporaryRoot, "repository");
  const worktreeRoot = path.join(temporaryRoot, "worktrees");
  const worktreePath = path.join(worktreeRoot, card.id);
  const storageRoot = path.join(temporaryRoot, "runtime-state");
  fs.mkdirSync(repositoryPath);
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(
    path.join(worktreePath, "src.ts"),
    "before repair\n",
    "utf8",
  );

  const project = {
    id: projectId,
    repository: {
      path: repositoryPath,
      worktreeRoot,
      validationCommand: "yarn validate",
    },
  } as ProjectConfig;
  const executionStore = new TaskExecutionStore(storageRoot, project);
  const planStore = new TaskPlanStore(storageRoot, project);
  executionStore.create({
    version: 1,
    projectId,
    cardId: card.id,
    phase: "validation",
    primarySessionId,
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
  planStore.create(plan, 1);
  planStore.storeVerification(card.id, 1, {
    version: 1,
    projectId,
    cardId: card.id,
    planRevision: 1,
    verdict: "pass",
    findings: [],
  } satisfies PlanVerificationResult);

  let headSha = "a".repeat(40);
  const git = {
    getCurrentBranch: vi.fn(async () => expectedBranch),
    getHeadSha: vi.fn(async () => headSha),
    getHeadTrackedFiles: vi.fn(async () => ["src.ts"]),
    getIndexEntries: vi.fn(
      async () => "100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0\tsrc.ts\0",
    ),
    getUntrackedFiles: vi.fn(async () => []),
  } as unknown as ReturnType<typeof createFixture>["git"];
  const runCommand = vi.fn<RunCommand>().mockResolvedValue({ exitCode: 0 });
  const runOpenCode = vi.fn<RunOpenCode>().mockResolvedValue({
    exitCode: 0,
    output: "repair complete",
    errorOutput: "",
  });

  return {
    project,
    worktreePath,
    executionStore,
    planStore,
    commands: new CommandRunner(runCommand),
    runCommand,
    openCode: new OpenCodeClient(runOpenCode),
    runOpenCode,
    git,
    setHeadSha: (sha) => {
      headSha = sha;
    },
  };
}

function runRepairs(
  fixture: ReturnType<typeof createFixture>,
  expectedSessionId = primarySessionId,
  repairOperationKey = operationKey,
) {
  return runTaskSessionValidationWithRepairs({
    validation: {
      project: fixture.project,
      cardId: card.id,
      expectedBranch,
      operationKey: repairOperationKey,
      worktreePath: fixture.worktreePath,
      taskRecordStore: fixture.executionStore,
      git: fixture.git,
      commands: fixture.commands,
      signal: new AbortController().signal,
      timeoutMilliseconds: 30_000,
    },
    openCode: fixture.openCode,
    planStore: fixture.planStore,
    card,
    expectedPrimarySessionId: expectedSessionId,
    repairRunOptions: {
      model: "implementation-model",
      variant: "xhigh",
      timeoutMilliseconds: 60_000,
      signal: new AbortController().signal,
    },
  });
}

describe("runTaskSessionValidationWithRepairs", () => {
  it("repairs a failed validation in the same session and reruns it to pass", async () => {
    const fixture = createFixture();
    fixture.runCommand
      .mockResolvedValueOnce({
        exitCode: 1,
        output: "assertion failed",
        errorOutput: "missing stored preference",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        output: "all tests passed",
        errorOutput: "",
      });
    fixture.runOpenCode.mockImplementation(async (options) => {
      expect(options.sessionId).toBe(primarySessionId);
      expect(options.prompt).toContain("yarn validate");
      expect(options.prompt).toContain("assertion failed");
      expect(options.prompt).toContain("attempt 1 of 2");
      expect(options.prompt).toContain(plan.requirements[0]?.text);
      expect(
        fixture.executionStore.read(card.id)?.retryCounters.validation,
      ).toBe(1);
      fs.writeFileSync(
        path.join(fixture.worktreePath, "src.ts"),
        "after repair\n",
        "utf8",
      );
      return {
        exitCode: 0,
        output: "repair prompt complete",
        errorOutput: "",
      };
    });

    const result = await runRepairs(fixture);

    expect(fixture.runCommand).toHaveBeenCalledTimes(2);
    expect(fixture.runOpenCode).toHaveBeenCalledOnce();
    expect(result.validation.status).toBe("passed");
    expect(result.attempts).toBe(1);
    expect(result.record.validationRepair).toMatchObject({
      cycleId: operationKey,
      status: "passed",
      evidence: {
        exitCode: 0,
        contentIdentity: result.validation.contentIdentity,
      },
    });
  });

  it("exhausts after two repairs and always reruns validation after the final one", async () => {
    const fixture = createFixture();
    fixture.runCommand.mockResolvedValue({
      exitCode: 1,
      output: "still failing",
      errorOutput: "failure diagnostic",
    });

    await expect(runRepairs(fixture)).resolves.toMatchObject({
      record: { validationRepair: { status: "exhausted" } },
    });
    expect(fixture.runCommand).toHaveBeenCalledTimes(
      MAX_VALIDATION_REPAIR_ATTEMPTS + 1,
    );
    expect(fixture.runOpenCode).toHaveBeenCalledTimes(
      MAX_VALIDATION_REPAIR_ATTEMPTS,
    );
    expect(fixture.executionStore.read(card.id)).toMatchObject({
      retryCounters: { validation: MAX_VALIDATION_REPAIR_ATTEMPTS },
      validationRepair: { cycleId: operationKey, status: "exhausted" },
    });

    await expect(runRepairs(fixture)).resolves.toMatchObject({
      record: { validationRepair: { status: "exhausted" } },
    });
    expect(fixture.runCommand).toHaveBeenCalledTimes(
      MAX_VALIDATION_REPAIR_ATTEMPTS + 2,
    );
    expect(fixture.runOpenCode).toHaveBeenCalledTimes(
      MAX_VALIDATION_REPAIR_ATTEMPTS,
    );
  });

  it("refuses a mismatched primary session before validation or repair", async () => {
    const fixture = createFixture();

    await expect(runRepairs(fixture, "ses_other-task")).rejects.toThrow(
      "mismatched primary session",
    );
    expect(fixture.runCommand).not.toHaveBeenCalled();
    expect(fixture.runOpenCode).not.toHaveBeenCalled();
  });

  it("resumes an interrupted pending repair by validating current work first", async () => {
    const fixture = createFixture();
    const record = fixture.executionStore.read(card.id);

    if (record === null) {
      throw new Error("Expected validation task record");
    }

    fixture.executionStore.compareAndSwap(card.id, record.revision, {
      ...record,
      retryCounters: { ...record.retryCounters, validation: 1 },
      validationRepair: { cycleId: operationKey, status: "active" },
      revision: record.revision + 1,
      updatedAt: "2026-10-24T09:01:00.000Z",
    });

    const result = await runRepairs(fixture);

    expect(result.validation.status).toBe("passed");
    expect(result.attempts).toBe(1);
    expect(fixture.runCommand).toHaveBeenCalledOnce();
    expect(fixture.runOpenCode).not.toHaveBeenCalled();
    expect(fixture.executionStore.read(card.id)?.validationRepair?.status).toBe(
      "passed",
    );
  });

  it("rejects a previously passing result when its source snapshot has changed", async () => {
    const fixture = createFixture();
    const firstResult = await runRepairs(fixture);
    expect(firstResult.validation.status).toBe("passed");
    expect(fixture.runCommand).toHaveBeenCalledOnce();

    fs.writeFileSync(
      path.join(fixture.worktreePath, "src.ts"),
      "changed source\n",
    );

    await expect(runRepairs(fixture)).rejects.toBeInstanceOf(
      StaleTaskSessionValidationEvidenceError,
    );
    expect(fixture.runCommand).toHaveBeenCalledOnce();
    expect(fixture.runOpenCode).not.toHaveBeenCalled();
  });

  it("retains passing validation evidence when the task advances to review", async () => {
    const fixture = createFixture();
    const result = await runRepairs(fixture);
    const reviewedRecord = transitionTaskExecutionRecord(result.record, {
      type: "validation-passed",
      eventId: "validation-passed-event",
      projectId,
      cardId: card.id,
      operationKey,
      occurredAt: new Date(
        Date.parse(result.record.updatedAt) + 1,
      ).toISOString(),
    });

    expect(Date.parse(reviewedRecord.updatedAt)).toBeGreaterThan(
      Date.parse(result.record.updatedAt),
    );
    expect(reviewedRecord.phase).toBe("review");
    expect(reviewedRecord.validationRepair?.status).toBe("passed");
    expect(reviewedRecord.validationRepair?.evidence?.contentIdentity).toBe(
      result.validation.contentIdentity,
    );
  });

  it("repairs coverage failures with the same loop and reruns validation after edits", async () => {
    const fixture = createFixture();
    fixture.project.repository.coverageCommand = "yarn coverage --threshold";
    fixture.runCommand
      .mockResolvedValueOnce({
        exitCode: 0,
        output: "validation passed",
        errorOutput: "",
      })
      .mockResolvedValueOnce({
        exitCode: 1,
        output: "coverage check failed",
        errorOutput: "repository threshold not met",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        output: "validation passed after repair",
        errorOutput: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        output: "coverage threshold satisfied",
        errorOutput: "",
      });
    fixture.runOpenCode.mockImplementation(async (options) => {
      expect(options.prompt).toContain(
        'Coverage command: "yarn coverage --threshold"',
      );
      expect(options.prompt).toContain("repository threshold not met");
      fs.writeFileSync(
        path.join(fixture.worktreePath, "src.ts"),
        "coverage fix applied\n",
        "utf8",
      );
      return { exitCode: 0, output: "fixed", errorOutput: "" };
    });

    const result = await runRepairs(fixture);

    expect(
      fixture.runCommand.mock.calls.map(([options]) => options.command),
    ).toEqual([
      "yarn validate",
      "yarn coverage --threshold",
      "yarn validate",
      "yarn coverage --threshold",
    ]);
    expect(fixture.runOpenCode).toHaveBeenCalledOnce();
    expect(result.validation.status).toBe("passed");
    expect(result.coverage?.status).toBe("passed");
    expect(result.attempts).toBe(1);
    expect(result.record.validationRepair).toMatchObject({
      status: "passed",
      evidence: { command: "yarn validate" },
      coverageEvidence: { command: "yarn coverage --threshold" },
    });
  });

  it("uses the shared two-attempt limit for repeated coverage failures", async () => {
    const fixture = createFixture();
    fixture.project.repository.coverageCommand = "yarn coverage";
    fixture.runCommand.mockImplementation(async ({ command }) =>
      command === "yarn validate"
        ? { exitCode: 0, output: "valid", errorOutput: "" }
        : { exitCode: 1, output: "coverage failed", errorOutput: "" },
    );

    await expect(runRepairs(fixture)).resolves.toMatchObject({
      record: { validationRepair: { status: "exhausted" } },
    });
    expect(
      fixture.runCommand.mock.calls.filter(
        ([options]) => options.command === "yarn validate",
      ),
    ).toHaveLength(MAX_VALIDATION_REPAIR_ATTEMPTS + 1);
    expect(
      fixture.runCommand.mock.calls.filter(
        ([options]) => options.command === "yarn coverage",
      ),
    ).toHaveLength(MAX_VALIDATION_REPAIR_ATTEMPTS + 1);
    expect(fixture.runOpenCode).toHaveBeenCalledTimes(
      MAX_VALIDATION_REPAIR_ATTEMPTS,
    );
  });

  it("starts a new bounded repair cycle only when task operation identity changes", async () => {
    const fixture = createFixture();
    fixture.runCommand.mockResolvedValue({
      exitCode: 1,
      output: "failure",
      errorOutput: "",
    });
    await expect(runRepairs(fixture)).resolves.toMatchObject({
      record: { validationRepair: { status: "exhausted" } },
    });

    const record = fixture.executionStore.read(card.id);

    if (record === null) {
      throw new Error("Expected exhausted validation task record");
    }

    fixture.executionStore.compareAndSwap(card.id, record.revision, {
      ...record,
      operationKey: "validation-cycle-two",
      revision: record.revision + 1,
      updatedAt: "2026-10-24T09:01:00.000Z",
    });

    await expect(
      runRepairs(fixture, primarySessionId, "validation-cycle-two"),
    ).resolves.toMatchObject({
      record: { validationRepair: { status: "exhausted" } },
    });
    expect(fixture.runCommand).toHaveBeenCalledTimes(
      2 * (MAX_VALIDATION_REPAIR_ATTEMPTS + 1),
    );
  });
});
