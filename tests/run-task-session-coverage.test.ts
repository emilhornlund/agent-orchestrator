import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import {
  CommandRunner,
  CommandTimeoutError,
  type RunCommand,
} from "../src/process/command-runner.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { runTaskSessionCoverage } from "../src/task-session/run-task-session-coverage.js";
import { getTaskSessionSourceSnapshotIdentity } from "../src/task-session/source-snapshot.js";

let temporaryRoot: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();

  if (temporaryRoot !== undefined) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

function createFixture(coverageCommand?: string) {
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-coverage-runner-"),
  );
  const repositoryPath = path.join(temporaryRoot, "repository");
  const worktreeRoot = path.join(temporaryRoot, "worktrees");
  const worktreePath = path.join(worktreeRoot, "card-one");
  const storageRoot = path.join(temporaryRoot, "runtime-state");
  fs.mkdirSync(repositoryPath);
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(
    path.join(worktreePath, "src.ts"),
    "source before\n",
    "utf8",
  );

  const project = {
    id: "project-one",
    repository: {
      path: repositoryPath,
      worktreeRoot,
      validationCommand: "yarn validate",
      ...(coverageCommand === undefined ? {} : { coverageCommand }),
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

  let headSha = "a".repeat(40);
  const getCurrentBranch = vi.fn(async () => "agent/card-one");
  const getHeadSha = vi.fn(async () => headSha);
  const getHeadTrackedFiles = vi.fn(async () => ["src.ts"]);
  const getIndexEntries = vi.fn(
    async () => "100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0\tsrc.ts\0",
  );
  const getUntrackedFiles = vi.fn(async () => [] as string[]);
  const runCommand = vi.fn<RunCommand>().mockResolvedValue({ exitCode: 0 });

  return {
    project,
    worktreePath,
    taskRecordStore,
    getCurrentBranch,
    getHeadSha,
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
    setHeadSha: (sha: string) => {
      headSha = sha;
    },
  };
}

function runCoverage(fixture: ReturnType<typeof createFixture>) {
  return runTaskSessionCoverage({
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
}

describe("runTaskSessionCoverage", () => {
  it("skips coverage when no command is configured", async () => {
    const fixture = createFixture();

    await expect(runCoverage(fixture)).resolves.toBeNull();
    expect(fixture.runCommand).not.toHaveBeenCalled();
    expect(fixture.getCurrentBranch).not.toHaveBeenCalled();
  });

  it("runs the configured command and binds its result to a source snapshot", async () => {
    const fixture = createFixture("yarn coverage --check-thresholds");
    fixture.runCommand.mockResolvedValue({
      exitCode: 0,
      output: "coverage thresholds satisfied",
      errorOutput: "",
    });

    const result = await runCoverage(fixture);

    expect(fixture.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "yarn coverage --check-thresholds",
        cwd: fixture.worktreePath,
        captureOutput: true,
        sessionLabel: "Task-session repository coverage",
      }),
    );
    expect(result).toMatchObject({
      command: "yarn coverage --check-thresholds",
      exitCode: 0,
      status: "passed",
      diagnostic: "coverage thresholds satisfied",
      contentIdentity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
  });

  it("treats a configured threshold failure as authoritative", async () => {
    const fixture = createFixture("yarn coverage --check-thresholds");
    fixture.runCommand.mockResolvedValue({
      exitCode: 1,
      output: "coverage threshold was not met",
      errorOutput: "",
    });

    const result = await runCoverage(fixture);

    expect(result).toMatchObject({
      status: "failed",
      exitCode: 1,
      diagnostic: "coverage threshold was not met",
    });
  });

  it("reports configured coverage timeout as a failed gate", async () => {
    const fixture = createFixture("yarn coverage");
    fixture.runCommand.mockRejectedValue(new CommandTimeoutError(30_000));

    await expect(runCoverage(fixture)).resolves.toMatchObject({
      status: "timed-out",
      timedOut: true,
      exitCode: null,
    });
  });

  it("does not treat coverage evidence from an earlier source snapshot as current", async () => {
    const fixture = createFixture("yarn coverage");
    const result = await runCoverage(fixture);

    if (result === null) {
      throw new Error("Expected configured coverage result");
    }

    fixture.setHeadSha("b".repeat(40));
    const currentIdentity = await getTaskSessionSourceSnapshotIdentity(
      fixture.git,
      fixture.worktreePath,
    );

    expect(result.contentIdentity).not.toBe(currentIdentity);
  });
});
