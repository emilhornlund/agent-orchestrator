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
  VALIDATION_REPAIR_EARLY_FINISH_MARKER,
  runTaskSessionValidationWithRepairs,
} from "../src/task-session/run-task-session-validation-repairs.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { transitionTaskExecutionRecord } from "../src/task-session/task-execution-transition.js";
import { TaskPlanStore } from "../src/task-session/task-plan-store.js";
import type { TaskPlan } from "../src/task-session/task-plan.js";
import type { RunCommand } from "../src/process/command-runner.js";
import { CommandRunner } from "../src/process/command-runner.js";
import type { PlanVerificationResult } from "../src/task-session/plan-verification.js";
import type { TrelloCard } from "../src/trello/trello-client.js";
import { getTaskSessionSourceSnapshotIdentity } from "../src/task-session/source-snapshot.js";

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
    opencode: { remediation: {} },
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
  it("replays a reserved repair and recognizes its unchanged source without rerunning quality", async () => {
    const fixture = createFixture();
    const contentIdentity = await getTaskSessionSourceSnapshotIdentity(
      fixture.git,
      fixture.worktreePath,
    );
    const operationId = `${operationKey}:validation:${operationKey}:pass:1`;
    const promptArtifact = fixture.executionStore.writePrimaryResultArtifact(
      `${operationId}:prompt`,
      { prompt: "resume exact reserved validation prompt" },
    );
    const initial = fixture.executionStore.read(card.id);
    if (initial === null) throw new Error("Expected validation record");
    fixture.executionStore.compareAndSwap(card.id, initial.revision, {
      ...initial,
      retryCounters: { ...initial.retryCounters, validation: 1 },
      validationRepair: {
        cycleId: operationKey,
        status: "active",
        maxAttempts: 3,
        evidence: {
          command: "yarn validate",
          startedAt: "2026-10-24T09:00:00.000Z",
          completedAt: "2026-10-24T09:01:00.000Z",
          exitCode: 1,
          status: "failed",
          diagnostic: "Still failing before repair.",
          contentIdentity,
        },
        coverageEvidence: {
          command: "",
          startedAt: "2026-10-24T09:00:00.000Z",
          completedAt: "2026-10-24T09:00:00.000Z",
          exitCode: null,
          status: "skipped",
          diagnostic: "Coverage is not configured.",
          contentIdentity,
        },
        activePrimaryOperation: {
          operationId,
          pass: 1,
          beforeContentIdentity: contentIdentity,
          validationResult: {
            command: "yarn validate",
            startedAt: "2026-10-24T09:00:00.000Z",
            completedAt: "2026-10-24T09:01:00.000Z",
            exitCode: 1,
            status: "failed",
            timedOut: false,
            aborted: false,
            diagnostic: "Still failing before repair.",
            contentIdentity,
          },
          promptContext: `sha256:${"b".repeat(64)}`,
          promptArtifact,
        },
      },
      revision: initial.revision + 1,
      updatedAt: "2026-10-24T09:01:00.000Z",
    });
    fixture.runOpenCode.mockImplementation(async (runOptions) => {
      expect(runOptions.prompt).toBe("resume exact reserved validation prompt");
      return { exitCode: 0, output: "no changes", errorOutput: "" };
    });

    const result = await runRepairs(fixture);

    expect(result.validation.status).toBe("failed");
    expect(result.validation.contentIdentity).toBe(contentIdentity);
    expect(result.record.validationRepair).toMatchObject({
      status: "exhausted",
      maxAttempts: 3,
      stopReason: "no-change",
      evidence: { status: "failed", contentIdentity },
    });
    expect(fixture.runOpenCode).toHaveBeenCalledOnce();
    expect(fixture.runCommand).not.toHaveBeenCalled();
  });

  it("resumes a reserved final validation repair before commands or exhaustion using its exact prompt and ID", async () => {
    const fixture = createFixture();
    const operationId = `${operationKey}:validation:${operationKey}:pass:2`;
    const prompt = "persisted validation repair prompt";
    const promptArtifact = fixture.executionStore.writePrimaryResultArtifact(
      `${operationId}:prompt`,
      { prompt },
    );
    const beforeContentIdentity = await getTaskSessionSourceSnapshotIdentity(
      fixture.git,
      fixture.worktreePath,
    );
    const record = fixture.executionStore.read(card.id)!;
    fixture.executionStore.compareAndSwap(card.id, record.revision, {
      ...record,
      retryCounters: { ...record.retryCounters, validation: 2 },
      validationRepair: {
        cycleId: operationKey,
        status: "active",
        maxAttempts: 2,
        activePrimaryOperation: {
          operationId,
          pass: 2,
          beforeContentIdentity,
          validationResult: {
            command: "yarn validate",
            startedAt: "2026-10-24T09:00:00.000Z",
            completedAt: "2026-10-24T09:00:01.000Z",
            exitCode: 1,
            status: "failed",
            timedOut: false,
            aborted: false,
            diagnostic: "previous validation failure",
            contentIdentity: `sha256:${"a".repeat(64)}`,
          },
          promptContext: `sha256:${"b".repeat(64)}`,
          promptArtifact,
        },
      },
      revision: record.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    fixture.project.opencode.remediation.validationMaxPasses = 0;
    fixture.runCommand.mockResolvedValue({
      exitCode: 0,
      output: "validation passed after resume",
      errorOutput: "",
    });
    fixture.runOpenCode.mockImplementation(async (runOptions) => {
      expect(runOptions.prompt).toBe(prompt);
      expect(fixture.runCommand).not.toHaveBeenCalled();
      expect(
        fixture.executionStore.read(card.id)?.retryCounters.validation,
      ).toBe(2);
      return { exitCode: 0, output: "resumed repair", errorOutput: "" };
    });

    const result = await runRepairs(fixture);
    expect(fixture.runCommand).toHaveBeenCalledOnce();
    expect(fixture.runOpenCode).toHaveBeenCalledOnce();
    expect(result.attempts).toBe(2);
    expect(result.record.validationRepair?.maxAttempts).toBe(2);
    expect(
      result.record.validationRepair?.activePrimaryOperation,
    ).toBeUndefined();
    expect(
      fixture.executionStore.read(card.id)?.primaryOperations?.[operationId],
    ).toMatchObject({
      executions: 1,
      status: "completed",
    });
  });

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
      expect(options.prompt).toContain(VALIDATION_REPAIR_EARLY_FINISH_MARKER);
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

  it("exhausts after the persisted default limit and reuses unchanged final evidence on restart", async () => {
    const fixture = createFixture();
    let repairNumber = 0;
    fixture.runCommand.mockResolvedValue({
      exitCode: 1,
      output: "still failing",
      errorOutput: "failure diagnostic",
    });
    fixture.runOpenCode.mockImplementation(async () => {
      repairNumber += 1;
      fs.writeFileSync(
        path.join(fixture.worktreePath, "src.ts"),
        `repair ${repairNumber}\n`,
      );
      return { exitCode: 0, output: "repair changed source", errorOutput: "" };
    });

    await expect(runRepairs(fixture)).resolves.toMatchObject({
      record: {
        validationRepair: {
          status: "exhausted",
          maxAttempts: MAX_VALIDATION_REPAIR_ATTEMPTS,
          stopReason: "attempt-limit",
          evidence: { status: "failed" },
        },
      },
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
      MAX_VALIDATION_REPAIR_ATTEMPTS + 1,
    );
    expect(fixture.runOpenCode).toHaveBeenCalledTimes(
      MAX_VALIDATION_REPAIR_ATTEMPTS,
    );
  });

  it("honors a zero validation maximum without dispatching a writer", async () => {
    const fixture = createFixture();
    fixture.project.opencode.remediation.validationMaxPasses = 0;
    fixture.runCommand.mockResolvedValue({
      exitCode: 1,
      output: "still failing",
      errorOutput: "failure diagnostic",
    });

    const result = await runRepairs(fixture);

    expect(result.attempts).toBe(0);
    expect(result.record.validationRepair).toMatchObject({
      status: "exhausted",
      maxAttempts: 0,
      stopReason: "attempt-limit",
      evidence: { status: "failed" },
    });
    expect(fixture.runCommand).toHaveBeenCalledOnce();
    expect(fixture.runOpenCode).not.toHaveBeenCalled();
  });

  it("recovers an exhausted publication by reusing unchanged evidence and refreshing only changed content", async () => {
    const fixture = createFixture();
    fixture.project.opencode.remediation.validationMaxPasses = 0;
    fixture.runCommand.mockResolvedValue({
      exitCode: 1,
      output: "quality remains failed",
      errorOutput: "failure",
    });
    const exhausted = await runRepairs(fixture);
    const publication = transitionTaskExecutionRecord(exhausted.record, {
      type: "validation-exhausted",
      eventId: `${operationKey}:validation-exhausted`,
      projectId,
      cardId: card.id,
      operationKey,
      occurredAt: new Date(
        Date.parse(exhausted.record.updatedAt) + 1,
      ).toISOString(),
    });
    fixture.executionStore.compareAndSwap(
      card.id,
      exhausted.record.revision,
      publication,
    );
    fixture.runCommand.mockClear();

    const unchanged = await runRepairs(fixture);

    expect(unchanged.record.phase).toBe("publication");
    expect(unchanged.validation).toMatchObject({
      status: "failed",
      contentIdentity: exhausted.validation.contentIdentity,
    });
    expect(fixture.runCommand).not.toHaveBeenCalled();
    expect(fixture.runOpenCode).not.toHaveBeenCalled();

    const beforeUnknownWriter = fixture.executionStore.read(card.id)!;
    fixture.executionStore.compareAndSwap(
      card.id,
      beforeUnknownWriter.revision,
      {
        ...beforeUnknownWriter,
        primaryOperations: {
          "unresolved-validation-writer": {
            id: "unresolved-validation-writer",
            activity: "validation-repair-pass-1",
            executions: 1,
            status: "ambiguous",
            lastSessionId: primarySessionId,
            updatedAt: new Date().toISOString(),
          },
        },
        revision: beforeUnknownWriter.revision + 1,
        updatedAt: new Date().toISOString(),
      },
    );
    await expect(runRepairs(fixture)).rejects.toThrow(
      "unresolved primary operation unresolved-validation-writer",
    );
    expect(fixture.runCommand).not.toHaveBeenCalled();
    const afterFence = fixture.executionStore.read(card.id)!;
    fixture.executionStore.compareAndSwap(card.id, afterFence.revision, {
      ...afterFence,
      primaryOperations: undefined,
      revision: afterFence.revision + 1,
      updatedAt: new Date().toISOString(),
    });

    fs.writeFileSync(
      path.join(fixture.worktreePath, "src.ts"),
      "changed before publication resume\n",
    );
    const refreshed = await runRepairs(fixture);

    expect(refreshed.record.phase).toBe("publication");
    expect(refreshed.validation.status).toBe("failed");
    expect(refreshed.validation.contentIdentity).not.toBe(
      exhausted.validation.contentIdentity,
    );
    expect(refreshed.record.retryCounters.validation).toBe(0);
    expect(fixture.runCommand).toHaveBeenCalledOnce();
    expect(fixture.runOpenCode).not.toHaveBeenCalled();
  });

  it("stops at a separately configured positive validation maximum", async () => {
    const fixture = createFixture();
    fixture.project.opencode.remediation.validationMaxPasses = 1;
    fixture.runCommand.mockResolvedValue({
      exitCode: 1,
      output: "still failing",
      errorOutput: "failure diagnostic",
    });
    fixture.runOpenCode.mockImplementation(async () => {
      fs.writeFileSync(
        path.join(fixture.worktreePath, "src.ts"),
        "repair changed source\n",
      );
      return { exitCode: 0, output: "repair complete", errorOutput: "" };
    });

    const result = await runRepairs(fixture);

    expect(result.attempts).toBe(1);
    expect(result.record.validationRepair).toMatchObject({
      status: "exhausted",
      maxAttempts: 1,
      stopReason: "attempt-limit",
    });
    expect(fixture.runOpenCode).toHaveBeenCalledOnce();
    expect(fixture.runCommand).toHaveBeenCalledTimes(2);
  });

  it("ends a source-identical no-op without repeating unchanged quality checks, including untracked content", async () => {
    const fixture = createFixture();
    const untracked = path.join(fixture.worktreePath, "draft.txt");
    fs.writeFileSync(untracked, "untracked draft\n", "utf8");
    vi.mocked(fixture.git.getUntrackedFiles).mockResolvedValue(["draft.txt"]);
    fixture.runCommand.mockResolvedValue({
      exitCode: 1,
      output: "assertion failed",
      errorOutput: "still failing",
    });
    const beforeIdentity = await getTaskSessionSourceSnapshotIdentity(
      fixture.git,
      fixture.worktreePath,
    );

    const result = await runRepairs(fixture);

    expect(result.record.validationRepair).toMatchObject({
      status: "exhausted",
      stopReason: "no-change",
      evidence: { status: "failed", contentIdentity: beforeIdentity },
    });
    expect(fs.readFileSync(untracked, "utf8")).toBe("untracked draft\n");
    expect(fixture.runCommand).toHaveBeenCalledOnce();
    expect(fixture.runOpenCode).toHaveBeenCalledOnce();

    await expect(runRepairs(fixture)).resolves.toMatchObject({
      validation: { status: "failed", contentIdentity: beforeIdentity },
      record: { validationRepair: { stopReason: "no-change" } },
    });
    expect(fixture.runCommand).toHaveBeenCalledOnce();
    expect(fixture.runOpenCode).toHaveBeenCalledOnce();
  });

  it("reuses evidence from the produced reservation when a completed writer is restarted before no-op disposition", async () => {
    const fixture = createFixture();
    fixture.runCommand.mockResolvedValue({
      exitCode: 1,
      output: "assertion failed",
      errorOutput: "still failing",
    });
    const interruption = new Error(
      "simulated restart after primary result persistence",
    );
    const compareAndSwap = fixture.executionStore.compareAndSwap.bind(
      fixture.executionStore,
    );
    const failDisposition = vi
      .spyOn(fixture.executionStore, "compareAndSwap")
      .mockImplementation((cardId, expectedRevision, nextRecord) => {
        if (
          nextRecord.validationRepair?.status === "exhausted" &&
          nextRecord.validationRepair.stopReason === "no-change"
        )
          throw interruption;
        return compareAndSwap(cardId, expectedRevision, nextRecord);
      });

    await expect(runRepairs(fixture)).rejects.toBe(interruption);
    failDisposition.mockRestore();
    const interrupted = fixture.executionStore.read(card.id);
    expect(interrupted?.validationRepair).toMatchObject({
      status: "active",
      maxAttempts: MAX_VALIDATION_REPAIR_ATTEMPTS,
      evidence: { status: "failed" },
      coverageEvidence: { status: "skipped" },
      activePrimaryOperation: {
        beforeContentIdentity: expect.stringMatching(/^sha256:/u),
      },
    });
    expect(interrupted?.primaryOperations).toMatchObject({
      [`${operationKey}:validation:${operationKey}:pass:1`]: {
        status: "completed",
        executions: 1,
      },
    });
    expect(fixture.runCommand).toHaveBeenCalledOnce();
    expect(fixture.runOpenCode).toHaveBeenCalledOnce();

    fixture.executionStore = new TaskExecutionStore(
      path.join(temporaryRoot!, "runtime-state"),
      fixture.project,
    );
    fixture.runOpenCode.mockImplementation(async () => {
      throw new Error("the completed primary operation must be replayed");
    });
    const resumed = await runRepairs(fixture);

    expect(resumed.record.validationRepair).toMatchObject({
      status: "exhausted",
      stopReason: "no-change",
      evidence: { status: "failed" },
      coverageEvidence: { status: "skipped" },
    });
    expect(fixture.runCommand).toHaveBeenCalledOnce();
    expect(fixture.runOpenCode).toHaveBeenCalledOnce();
  });

  it("honors explicit early finish after one changed repair and preserves its final failed evidence on restart", async () => {
    const fixture = createFixture();
    fixture.project.opencode.remediation.validationMaxPasses = 4;
    fixture.runCommand.mockResolvedValue({
      exitCode: 1,
      output: "still failing",
      errorOutput: "failure diagnostic",
    });
    fixture.runOpenCode.mockImplementation(async () => {
      fs.writeFileSync(
        path.join(fixture.worktreePath, "src.ts"),
        "attempted repair\n",
        "utf8",
      );
      return {
        exitCode: 0,
        output: JSON.stringify({
          type: "text",
          sessionID: primarySessionId,
          part: {
            type: "text",
            text: `No further source changes are useful.\n${VALIDATION_REPAIR_EARLY_FINISH_MARKER}`,
          },
        }),
        errorOutput: "",
      };
    });

    const first = await runRepairs(fixture);

    expect(first.attempts).toBe(1);
    expect(first.record.validationRepair).toMatchObject({
      status: "exhausted",
      maxAttempts: 4,
      stopReason: "finished-early",
      evidence: { status: "failed" },
    });
    expect(fixture.runOpenCode).toHaveBeenCalledOnce();
    expect(fixture.runCommand).toHaveBeenCalledTimes(2);

    const resumed = await runRepairs(fixture);
    expect(resumed.validation.status).toBe("failed");
    expect(resumed.attempts).toBe(1);
    expect(fixture.runOpenCode).toHaveBeenCalledOnce();
    expect(fixture.runCommand).toHaveBeenCalledTimes(2);
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

  it("refreshes passed quality evidence for changed source without renewing attempts", async () => {
    const fixture = createFixture();
    const firstResult = await runRepairs(fixture);
    expect(firstResult.validation.status).toBe("passed");
    expect(fixture.runCommand).toHaveBeenCalledOnce();

    fs.writeFileSync(
      path.join(fixture.worktreePath, "src.ts"),
      "changed source\n",
    );

    const refreshed = await runRepairs(fixture);
    expect(refreshed.validation.status).toBe("passed");
    expect(refreshed.validation.contentIdentity).not.toBe(
      firstResult.validation.contentIdentity,
    );
    expect(refreshed.attempts).toBe(0);
    expect(refreshed.record.validationRepair).toMatchObject({
      status: "passed",
      maxAttempts: MAX_VALIDATION_REPAIR_ATTEMPTS,
    });
    expect(fixture.runCommand).toHaveBeenCalledTimes(2);
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
    let repairNumber = 0;
    fixture.project.repository.coverageCommand = "yarn coverage";
    fixture.runCommand.mockImplementation(async ({ command }) =>
      command === "yarn validate"
        ? { exitCode: 0, output: "valid", errorOutput: "" }
        : { exitCode: 1, output: "coverage failed", errorOutput: "" },
    );
    fixture.runOpenCode.mockImplementation(async () => {
      repairNumber += 1;
      fs.writeFileSync(
        path.join(fixture.worktreePath, "src.ts"),
        `coverage repair ${repairNumber}\n`,
      );
      return { exitCode: 0, output: "repair changed source", errorOutput: "" };
    });

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
    let repairNumber = 0;
    fixture.runCommand.mockResolvedValue({
      exitCode: 1,
      output: "failure",
      errorOutput: "",
    });
    fixture.runOpenCode.mockImplementation(async () => {
      repairNumber += 1;
      fs.writeFileSync(
        path.join(fixture.worktreePath, "src.ts"),
        `cycle repair ${repairNumber}\n`,
      );
      return { exitCode: 0, output: "repair changed source", errorOutput: "" };
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
