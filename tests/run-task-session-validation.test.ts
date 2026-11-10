import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import {
  CommandRunAbortedError,
  CommandRunner,
  CommandTimeoutError,
  type RunCommand,
} from "../src/process/command-runner.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import {
  restorePersistedTaskSessionQualityEvidence,
  runTaskSessionValidation,
} from "../src/task-session/run-task-session-validation.js";
import { runTaskSessionCoverage } from "../src/task-session/run-task-session-coverage.js";
import {
  configureProcessRuntime,
  getProcessRuntime,
} from "../src/process/process-runtime.js";

const execFile = promisify(nodeExecFile);

let temporaryRoot: string | undefined;
let additionalTemporaryRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  configureProcessRuntime({
    runtimeRoot: getProcessRuntime().artifactRoot,
    signal: new AbortController().signal,
  });

  if (temporaryRoot !== undefined) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
  for (const root of additionalTemporaryRoots)
    fs.rmSync(root, { recursive: true, force: true });
  additionalTemporaryRoots = [];
});

function createFixture(
  options: {
    validationCommand?: string | null;
    coverageCommand?: string | null;
  } = {},
) {
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-validation-runner-"),
  );
  const repositoryPath = path.join(temporaryRoot, "repository");
  const worktreeRoot = path.join(temporaryRoot, "worktrees");
  const worktreePath = path.join(worktreeRoot, "card-one");
  const storageRoot = path.join(temporaryRoot, "runtime-state");
  fs.mkdirSync(repositoryPath);
  fs.mkdirSync(worktreePath, { recursive: true });

  const project = {
    id: "project-one",
    repository: {
      path: repositoryPath,
      worktreeRoot,
      ...(options.validationCommand === null
        ? {}
        : {
            validationCommand: options.validationCommand ?? "yarn validate",
          }),
      ...(options.coverageCommand === null
        ? {}
        : options.coverageCommand === undefined
          ? {}
          : { coverageCommand: options.coverageCommand }),
    },
  } as ProjectConfig;
  const taskRecordStore = new TaskExecutionStore(storageRoot, project);
  taskRecordStore.create({
    version: 1,
    projectId: project.id,
    cardId: "card-one",
    phase: "validation",
    primarySessionId: "ses_primary",
    sessionCreationStatus: "bound",
    expectedBranch: "agent/card-one",
    operationKey: "implementation-one",
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

  const getCurrentBranch = vi.fn(async (worktreePath: string) => {
    void worktreePath;
    return "agent/card-one";
  });
  const getHeadSha = vi.fn(async () => "a".repeat(40));
  const getHeadTrackedFiles = vi.fn(async () => [] as string[]);
  const getIndexEntries = vi.fn(async () => "");
  const getUntrackedFiles = vi.fn(async () => [] as string[]);
  const runCommand = vi.fn<RunCommand>().mockResolvedValue({ exitCode: 0 });

  return {
    project,
    taskRecordStore,
    worktreePath,
    getCurrentBranch,
    runCommand,
    commands: new CommandRunner(runCommand),
    git: {
      getCurrentBranch,
      getHeadSha,
      getHeadTrackedFiles,
      getIndexEntries,
      getUntrackedFiles,
    } as Pick<
      GitClient,
      | "getCurrentBranch"
      | "getHeadSha"
      | "getHeadTrackedFiles"
      | "getIndexEntries"
      | "getUntrackedFiles"
    >,
  };
}

function runValidation(
  fixture: ReturnType<typeof createFixture>,
  overrides: Partial<{
    worktreePath: string;
    timeoutMilliseconds: number;
    signal: AbortSignal;
    secretValues: readonly string[];
  }> = {},
) {
  return runTaskSessionValidation({
    project: fixture.project,
    cardId: "card-one",
    expectedBranch: "agent/card-one",
    operationKey: "implementation-one",
    worktreePath: overrides.worktreePath ?? fixture.worktreePath,
    taskRecordStore: fixture.taskRecordStore,
    git: fixture.git,
    commands: fixture.commands,
    signal: overrides.signal ?? new AbortController().signal,
    timeoutMilliseconds: overrides.timeoutMilliseconds ?? 30_000,
    ...(overrides.secretValues === undefined
      ? {}
      : { secretValues: overrides.secretValues }),
  });
}

describe("runTaskSessionValidation", () => {
  it.each(["validation", "coverage"] as const)(
    "runs actual verbose %s output without mistaking a full summary for an output limit",
    async (gate) => {
      const fixture = createFixture({
        validationCommand:
          "node -e \"process.stdout.write('o'.repeat(3000));process.stderr.write('e'.repeat(3000))\"",
      });
      const artifactRoot = path.join(temporaryRoot!, "process-artifacts");
      configureProcessRuntime({
        runtimeRoot: artifactRoot,
        signal: new AbortController().signal,
      });
      fixture.commands = new CommandRunner();
      if (gate === "coverage")
        fixture.project.repository.coverageCommand =
          fixture.project.repository.validationCommand;

      const result =
        gate === "coverage"
          ? await runTaskSessionCoverage({
              project: fixture.project,
              cardId: "card-one",
              expectedBranch: "agent/card-one",
              operationKey: "implementation-one",
              worktreePath: fixture.worktreePath,
              taskRecordStore: fixture.taskRecordStore,
              git: fixture.git,
              commands: fixture.commands,
              signal: new AbortController().signal,
              timeoutMilliseconds: 30_000,
            })
          : await runValidation(fixture);

      expect(result?.status).toBe("passed");
      expect(result?.exitCode).toBe(0);
      expect(result?.diagnostic).toHaveLength(2_000);
      expect(result?.diagnostic).toContain("[truncated]");
      const [executionId] = fs.readdirSync(
        path.join(artifactRoot, "process-executions"),
      );
      expect(executionId).toBeDefined();
      const evidencePath = path.join(
        artifactRoot,
        "process-executions",
        executionId!,
      );
      expect(
        fs.readFileSync(path.join(evidencePath, "stdout.txt"), "utf8"),
      ).toBe("o".repeat(3_000));
      expect(
        fs.readFileSync(path.join(evidencePath, "stderr.txt"), "utf8"),
      ).toBe("e".repeat(3_000));
    },
  );
  it("runs the exact configured command in the owned worktree and records evidence", async () => {
    const fixture = createFixture();
    fixture.runCommand.mockResolvedValue({
      exitCode: 0,
      output: "all tests passed",
      errorOutput: "",
    });

    const result = await runValidation(fixture);

    expect(fixture.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: fixture.worktreePath,
        command: "yarn validate",
        timeoutMilliseconds: 30_000,
        captureOutput: true,
      }),
    );
    expect(fixture.getCurrentBranch).toHaveBeenCalledWith(fixture.worktreePath);
    expect(result).toMatchObject({
      command: "yarn validate",
      exitCode: 0,
      status: "passed",
      timedOut: false,
      aborted: false,
      diagnostic: "all tests passed",
      contentIdentity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(Date.parse(result.completedAt)).toBeGreaterThanOrEqual(
      Date.parse(result.startedAt),
    );
    expect(fixture.taskRecordStore.read("card-one")?.phase).toBe("validation");
  });

  it("reports a nonzero exit code as a validation failure", async () => {
    const fixture = createFixture();
    fixture.runCommand.mockResolvedValue({
      exitCode: 2,
      output: "test failure",
      errorOutput: "one test failed",
    });

    const result = await runValidation(fixture);

    expect(result).toMatchObject({
      exitCode: 2,
      status: "failed",
      diagnostic: "test failure\none test failed",
    });
  });

  it("returns bounded, redacted diagnostics", async () => {
    const fixture = createFixture();
    fixture.runCommand.mockResolvedValue({
      exitCode: 1,
      output: `${"output token-secret ".repeat(250)}\n`,
      errorOutput: "authorization: token-secret",
    });

    const result = await runValidation(fixture, {
      secretValues: ["token-secret"],
    });

    expect(result.diagnostic.length).toBeLessThanOrEqual(2_000);
    expect(result.diagnostic).not.toContain("token-secret");
    expect(result.diagnostic).toContain("[REDACTED]");
  });

  it("records timeout and abort outcomes as failures", async () => {
    const timeoutFixture = createFixture();
    timeoutFixture.runCommand.mockRejectedValue(
      new CommandTimeoutError(30_000),
    );

    await expect(runValidation(timeoutFixture)).resolves.toMatchObject({
      exitCode: null,
      status: "timed-out",
      timedOut: true,
      aborted: false,
      diagnostic: "Command exceeded safety timeout of 30000ms",
    });

    const abortedFixture = createFixture();
    abortedFixture.runCommand.mockRejectedValue(new CommandRunAbortedError());

    await expect(runValidation(abortedFixture)).resolves.toMatchObject({
      exitCode: null,
      status: "aborted",
      timedOut: false,
      aborted: true,
      diagnostic: "Command run aborted",
    });
  });

  it("records absent validation as skipped, not passed, without dispatch", async () => {
    const fixture = createFixture({ validationCommand: null });
    const result = await runValidation(fixture);
    expect(result).toMatchObject({
      status: "skipped",
      exitCode: null,
      command: "",
      diagnostic: "Not configured; skipped",
    });
    expect(fixture.runCommand).not.toHaveBeenCalled();
  });

  it("restores a persisted skipped publication checkpoint as skipped after store reopen", async () => {
    const fixture = createFixture({ validationCommand: null });
    const identity = `sha256:${"c".repeat(64)}`;
    const record = fixture.taskRecordStore.read("card-one")!;
    fixture.taskRecordStore.compareAndSwap("card-one", record.revision, {
      ...record,
      publicationQuality: {
        contentIdentity: identity,
        validation: {
          command: "",
          startedAt: "2026-10-24T09:00:00.000Z",
          completedAt: "2026-10-24T09:00:00.000Z",
          exitCode: null,
          status: "skipped",
          diagnostic: "Not configured; skipped",
          contentIdentity: identity,
        },
        coverageEvidence: {
          command: "",
          startedAt: "2026-10-24T09:00:00.000Z",
          completedAt: "2026-10-24T09:00:00.000Z",
          exitCode: null,
          status: "skipped",
          diagnostic: "Not configured; skipped",
          contentIdentity: identity,
        },
        review: null,
      },
      revision: record.revision + 1,
      updatedAt: "2026-10-24T09:00:01.000Z",
    });
    const script = `
      import { TaskExecutionStore } from ${JSON.stringify(path.resolve("src/task-session/task-execution-store.ts"))};
      import { restorePersistedTaskSessionQualityEvidence } from ${JSON.stringify(path.resolve("src/task-session/run-task-session-validation.ts"))};
      const input = JSON.parse(process.env.QUALITY_CHECKPOINT_INPUT);
      const record = new TaskExecutionStore(input.storageRoot, input.project).read("card-one");
      if (!record?.publicationQuality) throw new Error("Persisted publication quality was missing");
      process.stdout.write(JSON.stringify(restorePersistedTaskSessionQualityEvidence(record.publicationQuality.validation)));
    `;
    const { stdout } = await execFile(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? "",
          QUALITY_CHECKPOINT_INPUT: JSON.stringify({
            storageRoot: path.join(temporaryRoot!, "runtime-state"),
            project: fixture.project,
          }),
        },
        encoding: "utf8",
      },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      status: "skipped",
      exitCode: null,
      command: "",
    });
  });

  it("does not migrate statusless nullable old evidence into a pass", () => {
    const restored = restorePersistedTaskSessionQualityEvidence({
      command: "",
      startedAt: "2026-10-24T09:00:00.000Z",
      completedAt: "2026-10-24T09:00:00.000Z",
      exitCode: null,
      diagnostic: "execution interrupted",
      contentIdentity: `sha256:${"a".repeat(64)}`,
    });
    expect(restored).toMatchObject({ status: "uncertain", exitCode: null });
  });

  it("keeps historical statusless evidence passing only with a real zero exit and command", () => {
    const restored = restorePersistedTaskSessionQualityEvidence({
      command: "yarn validate",
      startedAt: "2026-10-24T09:00:00.000Z",
      completedAt: "2026-10-24T09:01:00.000Z",
      exitCode: 0,
      diagnostic: "passed",
      contentIdentity: `sha256:${"b".repeat(64)}`,
    });
    expect(restored).toMatchObject({ status: "passed", exitCode: 0 });
  });

  it("still verifies ownership, worktree and branch before returning skipped evidence", async () => {
    const fixture = createFixture({ validationCommand: null });
    fixture.getCurrentBranch.mockResolvedValue("agent/other-card");
    await expect(runValidation(fixture)).rejects.toThrow("branch mismatch");
    expect(fixture.runCommand).not.toHaveBeenCalled();
    expect(fixture.getCurrentBranch).toHaveBeenCalledWith(fixture.worktreePath);
  });

  it("invokes configured commands as real processes and records their observed exit", async () => {
    const fixture = createFixture({
      validationCommand:
        "node -e \"require('fs').writeFileSync('validation.marker', 'ran'); process.exit(7)\"",
    });
    fixture.commands = new CommandRunner();
    configureProcessRuntime({
      runtimeRoot: path.join(temporaryRoot!, "artifacts"),
      signal: new AbortController().signal,
    });
    const result = await runValidation(fixture);
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(7);
    expect(
      fs.readFileSync(
        path.join(fixture.worktreePath, "validation.marker"),
        "utf8",
      ),
    ).toBe("ran");
  });

  it("records a generic execution exception as uncertain rather than a verified nonzero failure", async () => {
    const fixture = createFixture();
    fixture.runCommand.mockRejectedValue(
      new Error("process outcome unavailable"),
    );
    await expect(runValidation(fixture)).resolves.toMatchObject({
      status: "uncertain",
      exitCode: null,
    });
  });

  it.each([
    { name: "neither", validation: false, coverage: false },
    { name: "validation only", validation: true, coverage: false },
    { name: "coverage only", validation: false, coverage: true },
    { name: "both", validation: true, coverage: true },
  ])(
    "executes only the configured commands with real processes ($name)",
    async ({ validation, coverage }) => {
      const markerRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "quality-matrix-"),
      );
      additionalTemporaryRoots.push(markerRoot);
      const markerValidation = path.join(markerRoot, "validation.marker");
      const markerCoverage = path.join(markerRoot, "coverage.marker");
      const makeCommand = (marker: string) =>
        `${process.execPath} -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`)}`;
      const fixture = createFixture({
        validationCommand: validation ? makeCommand(markerValidation) : null,
        coverageCommand: coverage ? makeCommand(markerCoverage) : null,
      });
      fixture.commands = new CommandRunner();
      configureProcessRuntime({
        runtimeRoot: path.join(temporaryRoot!, "artifacts"),
        signal: new AbortController().signal,
      });
      const validationResult = await runValidation(fixture);
      const coverageResult = await runTaskSessionCoverage({
        project: fixture.project,
        cardId: "card-one",
        expectedBranch: "agent/card-one",
        operationKey: "implementation-one",
        worktreePath: fixture.worktreePath,
        taskRecordStore: fixture.taskRecordStore,
        git: fixture.git,
        commands: fixture.commands,
        signal: new AbortController().signal,
        timeoutMilliseconds: 30_000,
      });
      expect(validationResult.status).toBe(validation ? "passed" : "skipped");
      expect(coverageResult.status).toBe(coverage ? "passed" : "skipped");
      expect(fs.existsSync(markerValidation)).toBe(validation);
      expect(fs.existsSync(markerCoverage)).toBe(coverage);
    },
  );

  it("classifies an actual interrupted process separately from a nonzero exit", async () => {
    const fixture = createFixture({
      validationCommand: `${process.execPath} -e "setInterval(() => {}, 1000)"`,
    });
    fixture.commands = new CommandRunner();
    configureProcessRuntime({
      runtimeRoot: path.join(temporaryRoot!, "interrupt-artifacts"),
      signal: new AbortController().signal,
    });
    const controller = new AbortController();
    const pending = runValidation(fixture, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).resolves.toMatchObject({
      status: "aborted",
      exitCode: null,
      aborted: true,
    });
  });

  it("records the actual nonzero process exit code rather than an agent-supplied result", async () => {
    const fixture = createFixture({
      validationCommand: `${process.execPath} -e "process.stdout.write('agent claims pass'); process.exit(23)"`,
    });
    fixture.commands = new CommandRunner();
    configureProcessRuntime({
      runtimeRoot: path.join(temporaryRoot!, "nonzero-artifacts"),
      signal: new AbortController().signal,
    });
    await expect(runValidation(fixture)).resolves.toMatchObject({
      status: "failed",
      exitCode: 23,
      diagnostic: "agent claims pass",
    });
  });

  it("preserves signal termination as uncertain with no invented numeric exit", async () => {
    const fixture = createFixture({ validationCommand: "kill -TERM $$" });
    fixture.commands = new CommandRunner();
    configureProcessRuntime({
      runtimeRoot: path.join(temporaryRoot!, "signal-artifacts"),
      signal: new AbortController().signal,
    });
    await expect(runValidation(fixture)).resolves.toMatchObject({
      status: "uncertain",
      exitCode: null,
      aborted: false,
      diagnostic: expect.stringContaining("SIGTERM"),
    });
  });

  it("keeps actual command results and markers isolated between projects", async () => {
    const first = createFixture({
      validationCommand: `${process.execPath} -e "require('fs').writeFileSync('first-project.marker', 'first')"`,
    });
    const secondRoot = path.join(temporaryRoot!, "project-two");
    const secondRepository = path.join(secondRoot, "repository");
    const secondWorktrees = path.join(secondRoot, "worktrees");
    const secondWorktree = path.join(secondWorktrees, "card-two");
    fs.mkdirSync(secondRepository, { recursive: true });
    fs.mkdirSync(secondWorktree, { recursive: true });
    const secondProject = {
      ...first.project,
      id: "project-two",
      repository: {
        path: secondRepository,
        worktreeRoot: secondWorktrees,
        validationCommand: `${process.execPath} -e "require('fs').writeFileSync('second-project.marker', 'second')"`,
      },
    } as ProjectConfig;
    const secondStore = new TaskExecutionStore(
      path.join(secondRoot, "state"),
      secondProject,
    );
    first.getCurrentBranch.mockImplementation(async (worktreePath) =>
      worktreePath === secondWorktree ? "agent/card-two" : "agent/card-one",
    );
    secondStore.create({
      version: 1,
      projectId: secondProject.id,
      cardId: "card-two",
      phase: "validation",
      primarySessionId: "ses_two",
      sessionCreationStatus: "bound",
      expectedBranch: "agent/card-two",
      operationKey: "operation-two",
      revision: 1,
      retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
      createdAt: "2026-10-24T09:00:00.000Z",
      updatedAt: "2026-10-24T09:00:00.000Z",
    });
    const commands = new CommandRunner();
    const signal = new AbortController().signal;
    configureProcessRuntime({
      runtimeRoot: path.join(temporaryRoot!, "project-isolation-artifacts"),
      signal,
    });
    const [firstResult, secondResult] = await Promise.all([
      runTaskSessionValidation({
        project: first.project,
        cardId: "card-one",
        expectedBranch: "agent/card-one",
        operationKey: "implementation-one",
        worktreePath: first.worktreePath,
        taskRecordStore: first.taskRecordStore,
        git: first.git,
        commands,
        signal,
        timeoutMilliseconds: 30_000,
      }),
      runTaskSessionValidation({
        project: secondProject,
        cardId: "card-two",
        expectedBranch: "agent/card-two",
        operationKey: "operation-two",
        worktreePath: secondWorktree,
        taskRecordStore: secondStore,
        git: first.git,
        commands,
        signal,
        timeoutMilliseconds: 30_000,
      }),
    ]);
    expect(firstResult).toMatchObject({
      status: "passed",
      command: first.project.repository.validationCommand,
    });
    expect(secondResult).toMatchObject({
      status: "passed",
      command: secondProject.repository.validationCommand,
    });
    expect(
      fs.readFileSync(
        path.join(first.worktreePath, "first-project.marker"),
        "utf8",
      ),
    ).toBe("first");
    expect(
      fs.readFileSync(
        path.join(secondWorktree, "second-project.marker"),
        "utf8",
      ),
    ).toBe("second");
    expect(
      fs.existsSync(path.join(first.worktreePath, "second-project.marker")),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(secondWorktree, "first-project.marker")),
    ).toBe(false);
  });

  it("rejects a wrong branch before command execution", async () => {
    const branchFixture = createFixture();
    branchFixture.getCurrentBranch.mockResolvedValue("agent/other-card");

    await expect(runValidation(branchFixture)).rejects.toThrow(
      "branch mismatch",
    );
    expect(branchFixture.runCommand).not.toHaveBeenCalled();
  });

  it("allows only explicitly identified exhausted feedback review validation", async () => {
    const fixture = createFixture();
    const previous = fixture.taskRecordStore.read("card-one")!;
    const changed = fixture.taskRecordStore.compareAndSwap(
      "card-one",
      previous.revision,
      {
        ...previous,
        phase: "review",
        feedbackRemediation: {
          operationId: "feedback:head:round",
          headSha: "a".repeat(40),
          ledgerRevision: 1,
          status: "changed",
        },
        retryCounters: { ...previous.retryCounters, review: 1 },
        reviewRepair: {
          cycleId: previous.operationKey,
          status: "exhausted",
          maxAttempts: 1,
          finalReview: {
            version: 1,
            projectId: "project-one",
            cardId: "card-one",
            verdict: "fail",
            requirementAssessments: [
              {
                requirementId: "REQ-1",
                status: "unsatisfied",
                details: "Remains for human review",
                evidence: [],
              },
            ],
            blockingFindings: [
              {
                kind: "defect",
                summary: "Unresolved",
                detail: "Needs human review",
              },
            ],
            reviewedContentIdentity: `sha256:${"a".repeat(64)}`,
          },
        },
        revision: previous.revision + 1,
        updatedAt: "2026-10-24T09:00:01.000Z",
      },
    );
    expect(changed.phase).toBe("review");
    await expect(runValidation(fixture)).rejects.toThrow(
      "requires validation or publication",
    );
    await expect(
      runTaskSessionValidation({
        project: fixture.project,
        cardId: "card-one",
        expectedBranch: "agent/card-one",
        operationKey: "implementation-one",
        worktreePath: fixture.worktreePath,
        taskRecordStore: fixture.taskRecordStore,
        git: fixture.git,
        commands: fixture.commands,
        signal: new AbortController().signal,
        timeoutMilliseconds: 30_000,
        feedbackReviewRecovery: true,
      }),
    ).resolves.toMatchObject({ status: "passed" });
  });
});
