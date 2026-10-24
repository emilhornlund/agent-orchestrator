import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
import { runTaskSessionValidation } from "../src/task-session/run-task-session-validation.js";

let temporaryRoot: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();

  if (temporaryRoot !== undefined) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

function createFixture(
  options: {
    validationCommand?: string | null;
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

  const getCurrentBranch = vi.fn(async () => "agent/card-one");
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
    signal: new AbortController().signal,
    timeoutMilliseconds: overrides.timeoutMilliseconds ?? 30_000,
    ...(overrides.secretValues === undefined
      ? {}
      : { secretValues: overrides.secretValues }),
  });
}

describe("runTaskSessionValidation", () => {
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

  it.each([
    ["missing", null],
    ["blank", "  "],
  ])(
    "rejects a %s validation command before running it",
    async (_label, command) => {
      const fixture = createFixture({ validationCommand: command });

      await expect(runValidation(fixture)).rejects.toThrow(
        "nonempty repository.validationCommand",
      );
      expect(fixture.runCommand).not.toHaveBeenCalled();
      expect(fixture.getCurrentBranch).not.toHaveBeenCalled();
    },
  );

  it("rejects a wrong branch before command execution", async () => {
    const branchFixture = createFixture();
    branchFixture.getCurrentBranch.mockResolvedValue("agent/other-card");

    await expect(runValidation(branchFixture)).rejects.toThrow(
      "branch mismatch",
    );
    expect(branchFixture.runCommand).not.toHaveBeenCalled();
  });
});
