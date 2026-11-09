import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { GitClient } from "../src/git/git-client.js";
import { CommandRunner } from "../src/process/command-runner.js";
import {
  captureSetupEffects,
  runRepositorySetup,
} from "../src/process/run-setup.js";
import { beginProcessEvidence } from "../src/process/process-runtime.js";
import type { ProjectConfig } from "../src/config/config.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { RunStore } from "../src/task-session/run-store.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import {
  persistTaskSessionContextWait,
  reconcileTaskSession,
  type TaskSessionRecoverySnapshot,
} from "../src/task-session/reconcile-task-session.js";
import type {
  TaskExecutionPhase,
  TaskExecutionRecord,
} from "../src/task-session/task-execution-record.js";
import { hasDueTaskSessionRecoveryWait } from "../src/orchestrator/run-orchestrator.js";
import type { RunRecord } from "../src/task-session/run-record.js";

let root: string;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(phase: TaskExecutionPhase = "validation") {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "task-session-recovery-"));
  const repositoryPath = path.join(root, "repo");
  const worktreeRoot = path.join(root, "worktrees");
  const worktreePath = path.join(worktreeRoot, "card");
  fs.mkdirSync(repositoryPath);
  fs.mkdirSync(worktreePath, { recursive: true });
  const project = {
    id: "project",
    autoMerge: false,
    trello: {
      workingListId: "working",
      reviewListId: "review",
      backlogListId: "backlog",
      doneListId: "done",
    },
    repository: { path: repositoryPath, worktreeRoot },
  } as ProjectConfig;
  const store = new TaskExecutionStore(path.join(root, "state"), project);
  const git = new GitClient();
  const sha = "a".repeat(40);
  const record: TaskExecutionRecord = {
    version: 1,
    projectId: "project",
    cardId: "card",
    phase,
    primarySessionId: "session",
    sessionCreationStatus: "bound",
    expectedBranch: "agent/card",
    ...(phase === "ci" || phase === "human-feedback" || phase === "done"
      ? {
          pullRequest: {
            number: 1,
            url: "https://github.com/o/r/pull/1",
            headSha: sha,
          },
        }
      : {}),
    operationKey: "operation",
    revision: 1,
    retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
    createdAt: "2026-10-24T09:00:00.000Z",
    updatedAt: "2026-10-24T09:00:00.000Z",
  };
  store.create(record);
  const baseSnapshot: TaskSessionRecoverySnapshot = {
    primarySessionAccessible: true,
    worktreeExists: true,
    worktreeBranch: "agent/card",
    worktreeHeadSha: sha,
    worktreeRebaseActive: false,
    trustedCommitSha:
      phase === "ci" || phase === "human-feedback" || phase === "done"
        ? sha
        : null,
    remoteBranchHeadSha: null,
    trelloListId:
      phase === "human-feedback" || phase === "ci"
        ? "review"
        : phase === "done"
          ? "done"
          : "working",
    pullRequest:
      phase === "ci" || phase === "human-feedback" || phase === "done"
        ? {
            number: 1,
            url: "https://github.com/o/r/pull/1",
            headSha: sha,
            state: phase === "done" ? "MERGED" : "OPEN",
          }
        : null,
    ciEvaluation:
      phase === "ci"
        ? {
            status: "passed",
            expectedHeadSha: sha,
            expectedCheckNames: ["Build"],
          }
        : null,
    feedbackHeadSha: phase === "human-feedback" ? sha : null,
    uncertainReplyIds: [],
    reconciledReplyIds: [],
  };
  const reconcile = (
    snapshot: Partial<TaskSessionRecoverySnapshot> = {},
    now?: () => number,
  ) =>
    reconcileTaskSession({
      project,
      cardId: "card",
      expectedBranch: "agent/card",
      operationKey: "operation",
      worktreePath,
      taskRecordStore: store,
      setupGit: git,
      retryIntervalMs: 1_000,
      ...(now === undefined ? {} : { now }),
      readAuthoritativeSnapshot: async () => ({ ...baseSnapshot, ...snapshot }),
    });
  return { project, store, git, sha, worktreePath, baseSnapshot, reconcile };
}

function canonicalSetupFixture() {
  const f = fixture("planning");
  const storageRoot = path.join(root, "canonical-state");
  const integrationId = JSON.stringify({
    trelloBoardId: "board",
    githubRepository: "owner/repo",
  });
  const lease = {
    integrationId,
    instanceId: "setup-recovery-instance",
    token: `setup-lease-${Date.now()}-${Math.random()}`,
    assertHeld() {},
  };
  const pinned = {
    integrationId,
    projectId: f.project.id,
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
    repositoryPath: f.project.repository.path,
    worktreeRoot: f.project.repository.worktreeRoot,
    storageRoot,
  };
  const runStore = new RunStore(storageRoot, "attempt-card", pinned, lease);
  runStore.create({
    version: 1,
    revision: 1,
    projectId: f.project.id,
    cardId: "card",
    attemptId: "attempt-card",
    taskKind: "implementation",
    pinned,
    lifecycle: "planning",
    checkpoint: "planning",
    publicationState: "none",
    operation: { id: null, kind: null, generation: 0 },
    wait: { reason: null, dependency: null, since: null, retryAt: null },
    owner: { instanceId: lease.instanceId, token: lease.token, generation: 1 },
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
  const authority = new ProjectRunAuthority(f.project.id, runStore, 1);
  const store = new TaskExecutionStore(storageRoot, f.project, authority);
  store.create(f.store.read("card")!);
  const reconcile = (
    snapshot: Partial<TaskSessionRecoverySnapshot> = {},
    now?: () => number,
  ) =>
    reconcileTaskSession({
      project: f.project,
      cardId: "card",
      expectedBranch: "agent/card",
      operationKey: "operation",
      worktreePath: f.worktreePath,
      taskRecordStore: store,
      setupGit: f.git,
      retryIntervalMs: 1_000,
      ...(now === undefined ? {} : { now }),
      readAuthoritativeSnapshot: async () => ({
        ...f.baseSnapshot,
        ...snapshot,
      }),
    });
  return { ...f, store, runStore, authority, reconcile };
}

describe("reconcileTaskSession", () => {
  it("adopts a completed setup process from authoritative evidence after restart", async () => {
    const f = canonicalSetupFixture();
    const marker = path.join(root, "first-setup-attempt");
    const setupCommand = `if [ ! -f '${marker}' ]; then touch '${marker}'; printf leftover > unrelated.txt; exit 9; fi`;
    f.project.repository.setupCommand = setupCommand;
    execFileSync("git", ["init", "-q"], { cwd: f.worktreePath });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: f.worktreePath,
    });
    execFileSync("git", ["config", "user.name", "Setup recovery"], {
      cwd: f.worktreePath,
    });
    fs.writeFileSync(path.join(f.worktreePath, "base.txt"), "base");
    execFileSync("git", ["add", "."], { cwd: f.worktreePath });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: f.worktreePath });
    execFileSync("git", ["branch", "-m", "agent/card"], {
      cwd: f.worktreePath,
    });
    const before = f.store.writePrimaryResultArtifact(
      "setup-before-recovery",
      JSON.parse(
        (await captureSetupEffects(f.git, f.worktreePath)).toString("utf8"),
      ) as unknown,
    );
    const current = f.store.read("card")!;
    const firstAttemptResult = await runRepositorySetup(new CommandRunner(), {
      cwd: f.worktreePath,
      command: setupCommand,
      timeoutMilliseconds: 5_000,
      artifactDirectory: f.store.processExecutionDirectory("card")!,
      sessionLogPath: path.join(root, "setup-failed-attempt.log"),
      sessionLabel: "failed setup attempt fixture",
    });
    expect(firstAttemptResult.exitCode).toBe(9);
    const firstAttemptAfter = f.store.writePrimaryResultArtifact(
      "setup-failed-attempt-after",
      JSON.parse(
        (await captureSetupEffects(f.git, f.worktreePath)).toString("utf8"),
      ) as unknown,
    );
    f.store.compareAndSwap("card", current.revision, {
      ...current,
      setup: {
        command: setupCommand,
        status: "active",
        worktreePath: f.worktreePath,
        before: before.reference,
        attemptBefore: firstAttemptAfter.reference,
        attempts: 2,
        history: [
          {
            command: setupCommand,
            worktreePath: f.worktreePath,
            before: before.reference,
            after: firstAttemptAfter.reference,
            executionId: firstAttemptResult.executionId,
            exitCode: 9,
            outcome: "failed",
          },
        ],
      },
      revision: current.revision + 1,
      updatedAt: "2026-10-24T09:00:01.000Z",
    });
    let executionId: string | undefined;
    await runRepositorySetup(new CommandRunner(), {
      cwd: f.worktreePath,
      command: setupCommand,
      timeoutMilliseconds: 5_000,
      artifactDirectory: f.store.processExecutionDirectory("card")!,
      sessionLogPath: path.join(root, "setup.log"),
      sessionLabel: "setup recovery fixture",
      onExecutionStarted: (id) => {
        executionId = id;
        const active = f.store.read("card")!;
        f.store.compareAndSwap("card", active.revision, {
          ...active,
          setup: { ...active.setup!, executionId: id },
          revision: active.revision + 1,
          updatedAt: new Date(Date.parse(active.updatedAt) + 1).toISOString(),
        });
      },
    });
    await expect(f.reconcile()).resolves.toMatchObject({ status: "resume" });
    expect(f.store.read("card")?.setup).toMatchObject({
      status: "passed",
      before: before.reference,
      attemptBefore: firstAttemptAfter.reference,
      executionId,
      exitCode: 0,
      after: expect.stringMatching(/^sha256:/u),
      history: [
        { before: before.reference, outcome: "failed" },
        {
          before: firstAttemptAfter.reference,
          outcome: "passed",
          after: expect.stringMatching(/^sha256:/u),
        },
      ],
    });
    fs.writeFileSync(
      path.join(f.worktreePath, "agent.txt"),
      "agent edited after setup",
    );
    await expect(f.reconcile()).resolves.toMatchObject({ status: "resume" });
    const executionPath = path.join(
      f.store.processExecutionDirectory("card")!,
      executionId!,
      "execution.json",
    );
    const metadata = JSON.parse(
      fs.readFileSync(executionPath, "utf8"),
    ) as Record<string, unknown>;
    fs.writeFileSync(
      executionPath,
      JSON.stringify({ ...metadata, command: "different command" }),
    );
    await expect(f.reconcile()).resolves.toMatchObject({
      status: "attention-required",
    });
  });

  it("rejects a content-corrupted persisted setup inventory on recovery", async () => {
    const f = canonicalSetupFixture();
    const command = "true";
    f.project.repository.setupCommand = command;
    execFileSync("git", ["init", "-q"], { cwd: f.worktreePath });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: f.worktreePath,
    });
    execFileSync("git", ["config", "user.name", "Setup recovery"], {
      cwd: f.worktreePath,
    });
    fs.writeFileSync(path.join(f.worktreePath, "base.txt"), "base");
    execFileSync("git", ["add", "."], { cwd: f.worktreePath });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: f.worktreePath });
    execFileSync("git", ["branch", "-m", "agent/card"], {
      cwd: f.worktreePath,
    });
    const current = f.store.read("card")!;
    const before = f.store.writePrimaryResultArtifact(
      "setup-before-corrupt-check",
      JSON.parse(
        (await captureSetupEffects(f.git, f.worktreePath)).toString("utf8"),
      ) as unknown,
    );
    f.store.compareAndSwap("card", current.revision, {
      ...current,
      setup: {
        command,
        status: "active",
        worktreePath: f.worktreePath,
        before: before.reference,
        attempts: 1,
        history: [],
      },
      revision: current.revision + 1,
      updatedAt: new Date(Date.parse(current.updatedAt) + 1).toISOString(),
    });
    let executionId: string | undefined;
    await runRepositorySetup(new CommandRunner(), {
      cwd: f.worktreePath,
      command,
      timeoutMilliseconds: 5_000,
      artifactDirectory: f.store.processExecutionDirectory("card")!,
      sessionLogPath: path.join(root, "corrupt-artifact-setup.log"),
      sessionLabel: "setup corrupt-artifact fixture",
      onExecutionStarted: (id) => {
        executionId = id;
        const active = f.store.read("card")!;
        f.store.compareAndSwap("card", active.revision, {
          ...active,
          setup: { ...active.setup!, executionId: id },
          revision: active.revision + 1,
          updatedAt: new Date(Date.parse(active.updatedAt) + 1).toISOString(),
        });
      },
    });
    await expect(f.reconcile()).resolves.toMatchObject({ status: "resume" });
    const after = f.store.read("card")!.setup!.after!;
    const artifactPath = path.join(
      f.runStore.storageRoot,
      "artifacts",
      "attempt-card",
      `sha256-${after.slice("sha256:".length)}`,
    );
    fs.writeFileSync(artifactPath, "corrupt content identity");
    await expect(f.reconcile()).resolves.toMatchObject({
      status: "attention-required",
      reason: expect.stringContaining("digest"),
    });
    expect(f.store.readProcessExecution("card", executionId!)).toMatchObject({
      executionId,
      command,
    });
  });

  it("waits on an authoritative live setup process and never replays it", async () => {
    const f = canonicalSetupFixture();
    const command = "touch setup-live-marker; sleep 20";
    f.project.repository.setupCommand = command;
    execFileSync("git", ["init", "-q"], { cwd: f.worktreePath });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: f.worktreePath,
    });
    execFileSync("git", ["config", "user.name", "Setup recovery"], {
      cwd: f.worktreePath,
    });
    fs.writeFileSync(path.join(f.worktreePath, "base.txt"), "base");
    execFileSync("git", ["add", "."], { cwd: f.worktreePath });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: f.worktreePath });
    execFileSync("git", ["branch", "-m", "agent/card"], {
      cwd: f.worktreePath,
    });
    const current = f.store.read("card")!;
    const before = f.store.writePrimaryResultArtifact(
      "setup-before-live",
      JSON.parse(
        (await captureSetupEffects(f.git, f.worktreePath)).toString("utf8"),
      ) as unknown,
    );
    f.store.compareAndSwap("card", current.revision, {
      ...current,
      setup: {
        command,
        status: "active",
        worktreePath: f.worktreePath,
        before: before.reference,
        attempts: 1,
        history: [],
      },
      revision: current.revision + 1,
      updatedAt: new Date(Date.parse(current.updatedAt) + 1).toISOString(),
    });
    const controller = new AbortController();
    let executionId: string | undefined;
    const running = runRepositorySetup(new CommandRunner(), {
      cwd: f.worktreePath,
      command,
      timeoutMilliseconds: 30_000,
      signal: controller.signal,
      artifactDirectory: f.store.processExecutionDirectory("card")!,
      sessionLogPath: path.join(root, "live-setup.log"),
      sessionLabel: "live setup recovery fixture",
      onExecutionStarted: (id) => {
        executionId = id;
        const active = f.store.read("card")!;
        f.store.compareAndSwap("card", active.revision, {
          ...active,
          setup: { ...active.setup!, executionId: id },
          revision: active.revision + 1,
          updatedAt: new Date(Date.parse(active.updatedAt) + 1).toISOString(),
        });
      },
    });
    try {
      const marker = path.join(f.worktreePath, "setup-live-marker");
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(marker) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fs.existsSync(marker)).toBe(true);
      await expect(f.reconcile()).resolves.toMatchObject({ status: "waiting" });
      expect(f.store.read("card")?.setup).toMatchObject({
        status: "active",
        executionId,
      });
    } finally {
      controller.abort();
      await expect(running).rejects.toThrow();
    }
    await expect(
      f.reconcile({}, () => Date.now() + 2_000),
    ).resolves.toMatchObject({ status: "resume" });
    expect(f.store.read("card")?.setup).toMatchObject({
      status: "pending",
      attempts: 1,
      history: [{ outcome: "failed" }],
    });
  });

  it("recovers a real process-runtime not-dispatched spawn-failure record", async () => {
    const f = canonicalSetupFixture();
    const command = "unavailable-shell-command";
    f.project.repository.setupCommand = command;
    execFileSync("git", ["init", "-q"], { cwd: f.worktreePath });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: f.worktreePath,
    });
    execFileSync("git", ["config", "user.name", "Setup recovery"], {
      cwd: f.worktreePath,
    });
    fs.writeFileSync(path.join(f.worktreePath, "base.txt"), "base");
    execFileSync("git", ["add", "."], { cwd: f.worktreePath });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: f.worktreePath });
    execFileSync("git", ["branch", "-m", "agent/card"], {
      cwd: f.worktreePath,
    });
    const before = f.store.writePrimaryResultArtifact(
      "setup-before-spawn-failure",
      JSON.parse(
        (await captureSetupEffects(f.git, f.worktreePath)).toString("utf8"),
      ) as unknown,
    );
    const execution = beginProcessEvidence(
      command,
      f.worktreePath,
      [],
      f.store.processExecutionDirectory("card"),
    );
    const current = f.store.read("card")!;
    f.store.compareAndSwap("card", current.revision, {
      ...current,
      setup: {
        command,
        status: "active",
        worktreePath: f.worktreePath,
        before: before.reference,
        executionId: execution.executionId,
        attempts: 1,
        history: [],
      },
      revision: current.revision + 1,
      updatedAt: new Date(Date.parse(current.updatedAt) + 1).toISOString(),
    });
    execution.finish("spawn-failure", {
      error: "spawn failed before dispatch",
    });
    await expect(f.reconcile()).resolves.toMatchObject({ status: "resume" });
    expect(f.store.read("card")?.setup).toMatchObject({
      status: "pending",
      attempts: 1,
      history: [{ outcome: "failed", executionId: execution.executionId }],
    });
  });

  it("retries a stopped timed-out setup after restart within the shared operation bound", async () => {
    const f = canonicalSetupFixture();
    const setupCommand = "touch timeout-effect; sleep 10";
    f.project.repository.setupCommand = setupCommand;
    execFileSync("git", ["init", "-q"], { cwd: f.worktreePath });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: f.worktreePath,
    });
    execFileSync("git", ["config", "user.name", "Setup recovery"], {
      cwd: f.worktreePath,
    });
    fs.writeFileSync(path.join(f.worktreePath, "base.txt"), "base");
    execFileSync("git", ["add", "."], { cwd: f.worktreePath });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: f.worktreePath });
    execFileSync("git", ["branch", "-m", "agent/card"], {
      cwd: f.worktreePath,
    });
    const before = f.store.writePrimaryResultArtifact(
      "setup-before-timeout",
      JSON.parse(
        (await captureSetupEffects(f.git, f.worktreePath)).toString("utf8"),
      ) as unknown,
    );
    const current = f.store.read("card")!;
    f.store.compareAndSwap("card", current.revision, {
      ...current,
      setup: {
        command: setupCommand,
        status: "active",
        worktreePath: f.worktreePath,
        before: before.reference,
        attempts: 1,
        history: [],
      },
      revision: current.revision + 1,
      updatedAt: "2026-10-24T09:00:01.000Z",
    });
    let executionId: string | undefined;
    await expect(
      runRepositorySetup(new CommandRunner(), {
        cwd: f.worktreePath,
        command: setupCommand,
        timeoutMilliseconds: 50,
        artifactDirectory: f.store.processExecutionDirectory("card")!,
        sessionLogPath: path.join(root, "timeout-setup.log"),
        sessionLabel: "setup timeout recovery fixture",
        onExecutionStarted: (id) => {
          executionId = id;
          const active = f.store.read("card")!;
          f.store.compareAndSwap("card", active.revision, {
            ...active,
            setup: { ...active.setup!, executionId: id },
            revision: active.revision + 1,
            updatedAt: new Date(Date.parse(active.updatedAt) + 1).toISOString(),
          });
        },
      }),
    ).rejects.toThrow(/timeout/i);
    await expect(f.reconcile()).resolves.toMatchObject({ status: "resume" });
    expect(f.store.read("card")?.setup).toMatchObject({
      status: "pending",
      attempts: 1,
      history: [{ outcome: "failed", executionId }],
    });
  });

  it("requires three authoritative stopped executions before pre-PR terminal finalization", async () => {
    const f = canonicalSetupFixture();
    const command = "exit 17";
    f.project.repository.setupCommand = command;
    execFileSync("git", ["init", "-q"], { cwd: f.worktreePath });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: f.worktreePath,
    });
    execFileSync("git", ["config", "user.name", "Setup recovery"], {
      cwd: f.worktreePath,
    });
    fs.writeFileSync(path.join(f.worktreePath, "base.txt"), "base");
    execFileSync("git", ["add", "."], { cwd: f.worktreePath });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: f.worktreePath });
    execFileSync("git", ["branch", "-m", "agent/card"], {
      cwd: f.worktreePath,
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const current = f.store.read("card")!;
      const before = f.store.writePrimaryResultArtifact(
        `setup-before-${attempt}`,
        JSON.parse(
          (await captureSetupEffects(f.git, f.worktreePath)).toString("utf8"),
        ) as unknown,
      );
      f.store.compareAndSwap("card", current.revision, {
        ...current,
        setup: {
          command,
          status: "active",
          worktreePath: f.worktreePath,
          before: before.reference,
          attempts: attempt,
          history: current.setup?.history ?? [],
        },
        revision: current.revision + 1,
        updatedAt: new Date(Date.parse(current.updatedAt) + 1).toISOString(),
      });
      await expect(
        runRepositorySetup(new CommandRunner(), {
          cwd: f.worktreePath,
          command,
          timeoutMilliseconds: 5_000,
          artifactDirectory: f.store.processExecutionDirectory("card")!,
          sessionLogPath: path.join(root, `setup-${attempt}.log`),
          sessionLabel: `setup failure ${attempt}`,
          onExecutionStarted: (executionId) => {
            const active = f.store.read("card")!;
            f.store.compareAndSwap("card", active.revision, {
              ...active,
              setup: { ...active.setup!, executionId },
              revision: active.revision + 1,
              updatedAt: new Date(
                Date.parse(active.updatedAt) + 1,
              ).toISOString(),
            });
          },
        }),
      ).resolves.toMatchObject({ exitCode: 17 });

      const recovered = await f.reconcile();
      if (attempt < 3) expect(recovered.status).toBe("resume");
      else
        expect(recovered).toMatchObject({
          status: "attention-required",
          record: {
            phase: "attention-required",
            terminalFailure: { kind: "implementation", outcome: "pending" },
            setup: {
              status: "failed",
              attempts: 3,
              history: [
                { outcome: "failed" },
                { outcome: "failed" },
                { outcome: "failed" },
              ],
            },
          },
        });
    }
  });

  it("refuses completed setup with missing or fabricated effect references", async () => {
    const f = fixture();
    f.project.repository.setupCommand = "yarn install";
    const current = f.store.read("card")!;
    f.store.compareAndSwap("card", current.revision, {
      ...current,
      setup: {
        command: "yarn install",
        status: "passed",
        worktreePath: f.worktreePath,
        before: `sha256:${"1".repeat(64)}`,
        after: `sha256:${"2".repeat(64)}`,
        executionId: "setup-process-1",
        exitCode: 0,
      },
      revision: current.revision + 1,
      updatedAt: "2026-10-24T09:00:01.000Z",
    });
    await expect(f.reconcile()).resolves.toMatchObject({
      status: "attention-required",
    });
    f.project.repository.setupCommand = "changed setup";
    await expect(f.reconcile()).resolves.toMatchObject({
      status: "attention-required",
    });
  });

  it("does not replay setup when its execution outcome or completed effects are ambiguous", async () => {
    const f = fixture();
    f.project.repository.setupCommand = "yarn install";
    for (const setup of [
      {
        command: "yarn install",
        status: "active" as const,
        worktreePath: f.worktreePath,
      },
      {
        command: "yarn install",
        status: "passed" as const,
        worktreePath: f.worktreePath,
      },
      {
        command: "yarn install",
        status: "failed" as const,
        worktreePath: f.worktreePath,
      },
    ]) {
      const current = f.store.read("card")!;
      f.store.compareAndSwap("card", current.revision, {
        ...current,
        setup,
        revision: current.revision + 1,
        updatedAt: new Date(Date.parse(current.updatedAt) + 1).toISOString(),
      });
      await expect(f.reconcile()).resolves.toMatchObject({
        status: "attention-required",
      });
      const persisted = f.store.read("card")!;
      if (persisted.phase === "attention-required") break;
    }
  });

  it("does not terminally fail setup without authoritative stopped-attempt evidence", async () => {
    const f = fixture();
    f.project.repository.setupCommand = "setup";
    const current = f.store.read("card")!;
    f.store.compareAndSwap("card", current.revision, {
      ...current,
      setup: {
        command: "setup",
        status: "failed",
        attempts: 3,
        history: [],
        diagnostic: "Setup failed after bounded retries",
      },
      revision: current.revision + 1,
      updatedAt: "2026-10-24T09:00:01.000Z",
    });
    await expect(f.reconcile()).resolves.toMatchObject({
      status: "attention-required",
      record: {
        phase: "attention-required",
      },
    });
    expect(f.store.read("card")?.terminalFailure).toBeUndefined();
  });

  it("preserves an open PR and ownership instead of terminally failing setup", async () => {
    const f = fixture("human-feedback");
    f.project.repository.setupCommand = "setup";
    const current = f.store.read("card")!;
    f.store.compareAndSwap("card", current.revision, {
      ...current,
      setup: {
        command: "setup",
        status: "failed",
        attempts: 3,
        history: [],
        diagnostic: "Setup evidence is incomplete",
      },
      revision: current.revision + 1,
      updatedAt: "2026-10-24T09:00:01.000Z",
    });
    const result = await f.reconcile();
    expect(result).toMatchObject({ status: "attention-required" });
    expect(f.store.read("card")).toMatchObject({
      pullRequest: { number: 1, url: "https://github.com/o/r/pull/1" },
    });
    expect(f.store.read("card")?.terminalFailure).toBeUndefined();
  });

  it("routes only confirmed absence to the durable primary reconstruction gate", async () => {
    const f = fixture();
    await expect(
      f.reconcile({ primarySessionAccessible: "confirmed-absent" }),
    ).resolves.toMatchObject({
      status: "reconstruction-required",
      record: { primarySessionId: "session" },
    });
    const unknown = fixture();
    await expect(
      unknown.reconcile({ primarySessionAccessible: "unknown" }),
    ).resolves.toMatchObject({ status: "waiting" });
    const conflict = fixture();
    await expect(
      conflict.reconcile({ primarySessionAccessible: "conflict" }),
    ).resolves.toMatchObject({ status: "attention-required" });
  });
  it.each(["ci", "human-feedback"] as const)(
    "reconstructs a lost published %s session after restart without changing its owning operation",
    async (phase) => {
      const f = fixture(phase);
      const initial = f.store.read("card")!;
      const operationId =
        phase === "ci" ? "ci-repair:published-head" : "feedback:request-17";
      f.store.compareAndSwap("card", initial.revision, {
        ...initial,
        primaryOperations: {
          [operationId]: {
            id: operationId,
            activity: phase === "ci" ? "ci-repair" : "feedback-correction",
            executions: 1,
            status: "dispatched",
            lastSessionId: "session",
            updatedAt: initial.updatedAt,
          },
        },
        revision: initial.revision + 1,
        updatedAt: "2026-10-24T09:00:00.001Z",
      });

      // A new store instance models process restart. Persisted PR identity is
      // authoritative even though recovery is occurring in a correction phase.
      const restarted = new TaskExecutionStore(
        path.join(root, "state"),
        f.project,
      );
      const result = await reconcileTaskSession({
        project: f.project,
        cardId: "card",
        expectedBranch: "agent/card",
        operationKey: "operation",
        worktreePath: f.worktreePath,
        taskRecordStore: restarted,
        retryIntervalMs: 1_000,
        readAuthoritativeSnapshot: async () => ({
          primarySessionAccessible: "confirmed-absent",
          worktreeExists: true,
          worktreeBranch: "agent/card",
          worktreeHeadSha: f.sha,
          worktreeRebaseActive: false,
          trustedCommitSha: f.sha,
          remoteBranchHeadSha: null,
          trelloListId: "review",
          pullRequest: {
            number: 1,
            url: "https://github.com/o/r/pull/1",
            headSha: f.sha,
            state: "OPEN",
          },
          ciEvaluation:
            phase === "ci"
              ? {
                  status: "failed",
                  expectedHeadSha: f.sha,
                  expectedCheckNames: ["Build"],
                  failures: [],
                }
              : null,
          feedbackHeadSha: phase === "human-feedback" ? f.sha : null,
          uncertainReplyIds: [],
          reconciledReplyIds: [],
        }),
      });

      expect(result.status).toBe("reconstruction-required");
      expect(result.record.pullRequest).toMatchObject({
        number: 1,
        url: "https://github.com/o/r/pull/1",
      });
      expect(result.record.primaryOperations?.[operationId]).toMatchObject({
        id: operationId,
        status: "dispatched",
        executions: 1,
        lastSessionId: "session",
      });
      expect(Object.keys(result.record.primaryOperations ?? {})).toEqual([
        operationId,
      ]);
    },
  );

  it("does not authorize reconstruction when card, worktree, or PR evidence is unsafe", async () => {
    const moved = fixture();
    await expect(
      moved.reconcile({
        primarySessionAccessible: "confirmed-absent",
        trelloListId: "operator-moved",
      }),
    ).resolves.toMatchObject({ status: "waiting" });
    const wrongBranch = fixture();
    await expect(
      wrongBranch.reconcile({
        primarySessionAccessible: "confirmed-absent",
        worktreeBranch: "agent/other",
      }),
    ).resolves.toMatchObject({ status: "attention-required" });
    const wrongPrHead = fixture("ci");
    await expect(
      wrongPrHead.reconcile({
        primarySessionAccessible: "confirmed-absent",
        pullRequest: {
          number: 1,
          url: "https://github.com/o/r/pull/1",
          headSha: "b".repeat(40),
          state: "OPEN",
        },
      }),
    ).resolves.toMatchObject({ status: "attention-required" });
  });
  it("keeps a captured replacement bound but blocked until reconstruction is verified", async () => {
    const f = fixture();
    const current = f.store.read("card")!;
    f.store.compareAndSwap("card", current.revision, {
      ...current,
      sessionRecovery: {
        originalSessionId: "session",
        replacementSessionIds: ["replacement"],
        status: "replacement-bound",
      },
      primarySessionId: "replacement",
      revision: current.revision + 1,
      updatedAt: "2026-10-24T09:00:00.001Z",
    });
    await expect(
      f.reconcile({ primarySessionAccessible: "reachable" }),
    ).resolves.toMatchObject({ status: "reconstruction-required" });
    const bound = f.store.read("card")!;
    f.store.compareAndSwap("card", bound.revision, {
      ...bound,
      sessionRecovery: {
        ...bound.sessionRecovery!,
        status: "reconstruction-blocked",
      },
      revision: bound.revision + 1,
      updatedAt: "2026-10-24T09:00:00.002Z",
    });
    await expect(
      f.reconcile({ primarySessionAccessible: "reachable" }),
    ).resolves.toMatchObject({ status: "attention-required" });
  });
  it("applies the primary recovery gate after publication checkpoint validation", async () => {
    const f = fixture("publication");
    await expect(
      f.reconcile({
        primarySessionAccessible: "confirmed-absent",
        trustedCommitSha: f.sha,
        worktreeHeadSha: f.sha,
      }),
    ).resolves.toMatchObject({ status: "reconstruction-required" });
  });
  it("keeps process-failed reconstruction policy-pending while safety violations require attention", async () => {
    const processFailed = fixture();
    const failed = processFailed.store.read("card")!;
    processFailed.store.compareAndSwap("card", failed.revision, {
      ...failed,
      sessionRecovery: {
        originalSessionId: "session",
        status: "reconstruction-process-failed",
      },
      revision: failed.revision + 1,
      updatedAt: "2026-10-24T09:00:00.001Z",
    });
    await expect(
      processFailed.reconcile({ primarySessionAccessible: "reachable" }),
    ).resolves.toMatchObject({ status: "waiting" });
    const boundaryFailed = fixture();
    const blocked = boundaryFailed.store.read("card")!;
    boundaryFailed.store.compareAndSwap("card", blocked.revision, {
      ...blocked,
      sessionRecovery: {
        originalSessionId: "session",
        status: "reconstruction-blocked",
      },
      revision: blocked.revision + 1,
      updatedAt: "2026-10-24T09:00:00.001Z",
    });
    await expect(
      boundaryFailed.reconcile({ primarySessionAccessible: "reachable" }),
    ).resolves.toMatchObject({ status: "attention-required" });
  });
  it("presents unavailable reconstruction evidence as a paced T1 wait and reopens the gate after recovery", async () => {
    const f = fixture();
    const record = f.store.read("card")!;
    const waiting = persistTaskSessionContextWait(
      f.store,
      record,
      {
        project: f.project,
        cardId: record.cardId,
        expectedBranch: record.expectedBranch!,
        operationKey: record.operationKey,
        worktreePath: f.worktreePath,
        taskRecordStore: f.store,
        retryIntervalMs: 1_000,
        now: () => Date.parse("2026-10-24T09:00:00.000Z"),
        readAuthoritativeSnapshot: async () => {
          throw new Error("not invoked");
        },
      },
      "Current Trello attachment context is temporarily unavailable",
    );
    expect(waiting).toMatchObject({
      status: "waiting",
      record: {
        sessionRecovery: { contextAvailability: "unavailable" },
      },
    });
    await expect(
      f.reconcile({ primarySessionAccessible: "reachable" }, () =>
        Date.parse("2026-10-24T09:00:00.500Z"),
      ),
    ).resolves.toMatchObject({ status: "waiting" });
    await expect(
      f.reconcile({ primarySessionAccessible: "confirmed-absent" }, () =>
        Date.parse("2026-10-24T09:00:01.000Z"),
      ),
    ).resolves.toMatchObject({ status: "reconstruction-required" });
  });
  it("keeps replacement phase and baseline orthogonal to context waits", async () => {
    for (const status of [
      "replacement-creating",
      "replacement-ambiguous",
      "replacement-bound",
    ] as const) {
      const f = fixture();
      const record = f.store.read("card")!;
      const baseline = {
        sourceIdentity: `sha256:${"a".repeat(64)}`,
        head: f.sha,
        branch: "agent/card",
        branchRef: f.sha,
        refsIdentity: "refs-before",
      };
      f.store.compareAndSwap("card", record.revision, {
        ...record,
        sessionRecovery: {
          originalSessionId: "session",
          status,
          ...(status === "replacement-bound"
            ? { reconstructionBaseline: baseline }
            : {}),
        },
        revision: record.revision + 1,
        updatedAt: "2026-10-24T09:00:00.001Z",
      });
      const current = f.store.read("card")!;
      persistTaskSessionContextWait(
        f.store,
        current,
        {
          project: f.project,
          cardId: "card",
          expectedBranch: "agent/card",
          operationKey: "operation",
          worktreePath: f.worktreePath,
          taskRecordStore: f.store,
          retryIntervalMs: 1_000,
          readAuthoritativeSnapshot: async () => {
            throw new Error("not used");
          },
        },
        "Context service temporarily unavailable",
      );
      const waited = f.store.read("card")!;
      expect(waited.sessionRecovery?.status).toBe(status);
      expect(waited.sessionRecovery?.contextAvailability).toBe("unavailable");
      if (status === "replacement-bound")
        expect(waited.sessionRecovery?.reconstructionBaseline).toEqual(
          baseline,
        );
      const reconciled = await f.reconcile(
        { primarySessionAccessible: "reachable" },
        () => Date.now() + 2_000,
      );
      expect(reconciled.status).toBe(
        status === "replacement-bound" ? "reconstruction-required" : "waiting",
      );
      expect(f.store.read("card")?.sessionRecovery?.status).toBe(status);
    }
  });
  it("clears context-unavailable state atomically with verified reconstruction and does not dispatch again", async () => {
    const f = fixture();
    const baseline = {
      sourceIdentity: `sha256:${"a".repeat(64)}`,
      head: f.sha,
      branch: "agent/card",
      branchRef: f.sha,
      refsIdentity: "refs-before",
    };
    const initial = f.store.read("card")!;
    f.store.compareAndSwap("card", initial.revision, {
      ...initial,
      sessionRecovery: {
        originalSessionId: "session",
        replacementSessionIds: ["replacement"],
        status: "replacement-bound",
        reconstructionBaseline: baseline,
      },
      primarySessionId: "replacement",
      revision: initial.revision + 1,
      updatedAt: "2026-10-24T09:00:00.001Z",
    });
    const bound = f.store.read("card")!;
    persistTaskSessionContextWait(
      f.store,
      bound,
      {
        project: f.project,
        cardId: "card",
        expectedBranch: "agent/card",
        operationKey: "operation",
        worktreePath: f.worktreePath,
        taskRecordStore: f.store,
        retryIntervalMs: 1_000,
        readAuthoritativeSnapshot: async () => {
          throw new Error("not used");
        },
      },
      "Trello context unavailable",
    );
    await expect(
      f.reconcile(
        { primarySessionAccessible: "reachable" },
        () => Date.now() + 2_000,
      ),
    ).resolves.toMatchObject({ status: "reconstruction-required" });
    const verifying = f.store.read("card")!;
    f.store.compareAndSwap("card", verifying.revision, {
      ...verifying,
      recoveryWait: undefined,
      sessionRecovery: {
        ...verifying.sessionRecovery!,
        status: "reconstruction-verified",
        contextAvailability: "available",
        contextAvailabilityReason: undefined,
      },
      revision: verifying.revision + 1,
      updatedAt: new Date(
        Math.max(Date.now(), Date.parse(verifying.updatedAt) + 1),
      ).toISOString(),
    });
    await expect(
      f.reconcile({ primarySessionAccessible: "reachable" }),
    ).resolves.toMatchObject({ status: "resume" });
    await expect(
      f.reconcile({ primarySessionAccessible: "reachable" }),
    ).resolves.toMatchObject({ status: "resume" });
    expect(f.store.read("card")?.sessionRecovery).toMatchObject({
      status: "reconstruction-verified",
      contextAvailability: "available",
      reconstructionBaseline: baseline,
      replacementSessionIds: ["replacement"],
    });
  });
  it("worker gate authorizes only a schema-valid due task recovery wait", () => {
    const run = {
      lifecycle: "waiting",
      cardId: "card",
      compatibility: {
        "task-execution-card": {
          version: 1,
          projectId: "project",
          cardId: "card",
          phase: "validation",
          primarySessionId: "session",
          sessionCreationStatus: "bound",
          expectedBranch: "agent/card",
          operationKey: "operation",
          revision: 1,
          retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
          createdAt: "2026-10-24T09:00:00.000Z",
          updatedAt: "2026-10-24T09:00:00.000Z",
          recoveryWait: {
            kind: "dependency",
            reason: "dependency outage",
            resumePhase: "validation",
            since: "2026-10-24T09:00:00.000Z",
            retryAt: "2026-10-24T09:00:01.000Z",
            attempts: 1,
            notificationId: "project/card/operation/dependency",
          },
        },
      },
    } as unknown as RunRecord;
    expect(
      hasDueTaskSessionRecoveryWait(
        run,
        Date.parse("2026-10-24T09:00:00.500Z"),
      ),
    ).toBe(false);
    expect(
      hasDueTaskSessionRecoveryWait(
        run,
        Date.parse("2026-10-24T09:00:01.000Z"),
      ),
    ).toBe(true);
    expect(
      hasDueTaskSessionRecoveryWait(
        { ...run, lifecycle: "implementation" },
        Date.now(),
      ),
    ).toBe(false);
    expect(
      hasDueTaskSessionRecoveryWait({ ...run, compatibility: {} }, Date.now()),
    ).toBe(false);
  });
  it("resumes a verified restart at its persisted phase", async () => {
    const f = fixture();
    const result = await f.reconcile();
    expect(result).toMatchObject({ status: "resume", phase: "validation" });
  });

  it("keeps the authoritative checkpoint recoverable when a dependency read fails", async () => {
    const f = fixture("validation");
    const result = await reconcileTaskSession({
      project: f.project,
      cardId: "card",
      expectedBranch: "agent/card",
      operationKey: "operation",
      worktreePath: path.join(f.project.repository.worktreeRoot, "card"),
      taskRecordStore: f.store,
      retryIntervalMs: 1_000,
      readAuthoritativeSnapshot: async () => {
        throw new Error("GitHub service unavailable");
      },
    });
    expect(result).toMatchObject({
      status: "waiting",
      checkpoint: "validation",
    });
    expect(f.store.read("card")?.phase).toBe("validation");
    const persisted = f.store.read("card")!;
    expect(persisted.recoveryWait?.reason).toContain(
      "snapshot could not be read",
    );
    const restarted = new TaskExecutionStore(
      path.join(root, "state"),
      f.project,
    );
    let reads = 0;
    const early = await reconcileTaskSession({
      project: f.project,
      cardId: "card",
      expectedBranch: "agent/card",
      operationKey: "operation",
      worktreePath: path.join(f.project.repository.worktreeRoot, "card"),
      taskRecordStore: restarted,
      retryIntervalMs: 1_000,
      now: () => Date.parse(persisted.recoveryWait!.since) + 1,
      readAuthoritativeSnapshot: async () => {
        reads += 1;
        throw new Error("should be paced");
      },
    });
    expect(early.status).toBe("waiting");
    expect(reads).toBe(0);
  });

  it("persists attention-required for missing session identity and untrusted partial publication", async () => {
    const f = fixture();
    const result = await f.reconcile({ primarySessionAccessible: null });
    expect(result.status).toBe("waiting");
    expect(f.store.read("card")?.phase).toBe("validation");

    const publication = fixture("publication");
    const partial = await publication.reconcile({
      trustedCommitSha: null,
      remoteBranchHeadSha: "b".repeat(40),
    });
    expect(partial.status).toBe("attention-required");
  });

  it("recovers only a verified uncommitted validation-exhausted publication", async () => {
    const f = fixture("publication");
    const record = f.store.read("card");
    expect(record).not.toBeNull();
    f.store.compareAndSwap("card", record!.revision, {
      ...record!,
      validationRepair: { cycleId: "operation", status: "exhausted" },
      retryCounters: { ...record!.retryCounters, validation: 2 },
      revision: record!.revision + 1,
      updatedAt: "2026-10-24T09:00:01.000Z",
    });
    expect(
      (await f.reconcile({ verifiedUncommittedPublication: true })).status,
    ).toBe("resume");

    const withRemote = fixture("publication");
    const owned = withRemote.store.read("card");
    expect(owned).not.toBeNull();
    withRemote.store.compareAndSwap("card", owned!.revision, {
      ...owned!,
      validationRepair: { cycleId: "operation", status: "exhausted" },
      retryCounters: { ...owned!.retryCounters, validation: 2 },
      revision: owned!.revision + 1,
      updatedAt: "2026-10-24T09:00:01.000Z",
    });
    expect(
      (
        await withRemote.reconcile({
          verifiedUncommittedPublication: true,
          remoteBranchHeadSha: "b".repeat(40),
        })
      ).status,
    ).toBe("attention-required");
  });

  it("resumes an unreviewed publication after review execution failure without inventing a verdict", async () => {
    const f = fixture("publication");
    const record = f.store.read("card")!;
    const identity = `sha256:${"a".repeat(64)}`;
    f.store.compareAndSwap("card", record.revision, {
      ...record,
      reviewUnavailable: {
        contentIdentity: identity,
        diagnostic: "OpenCode review execution failed",
      },
      validationRepair: {
        cycleId: "operation",
        status: "passed",
        evidence: {
          command: "yarn validate",
          startedAt: record.createdAt,
          completedAt: record.updatedAt,
          exitCode: 0,
          diagnostic: "pass",
          contentIdentity: identity,
        },
      },
      revision: record.revision + 1,
      updatedAt: "2026-10-24T09:00:01.000Z",
    });
    const restarted = await f.reconcile({
      verifiedUncommittedPublication: true,
    });
    expect(restarted.status).toBe("resume");
    expect(f.store.read("card")?.reviewRepair?.finalReview).toBeUndefined();
    expect(f.store.read("card")?.reviewUnavailable?.diagnostic).toContain(
      "execution failed",
    );
    const sameRestart = await f.reconcile({
      verifiedUncommittedPublication: true,
    });
    expect(sameRestart.status).toBe("resume");
    expect(f.store.read("card")?.pullRequest).toBeUndefined();
  });

  it.each([
    ["a remote task branch", { remoteBranchHeadSha: "b".repeat(40) }],
    [
      "an unowned pull request",
      {
        pullRequest: {
          number: 9,
          url: "https://github.com/o/r/pull/9",
          headSha: "b".repeat(40),
          state: "OPEN" as const,
        },
      },
    ],
    ["an active rebase", { worktreeRebaseActive: true }],
  ] as const)(
    "refuses an unreviewed publication restart with %s",
    async (_case, unsafeSnapshot) => {
      const f = fixture("publication");
      const record = f.store.read("card")!;
      f.store.compareAndSwap("card", record.revision, {
        ...record,
        reviewUnavailable: {
          contentIdentity: `sha256:${"b".repeat(64)}`,
          diagnostic: "AI review unavailable",
        },
        revision: record.revision + 1,
        updatedAt: "2026-10-24T09:00:01.000Z",
      });
      const result = await f.reconcile({
        verifiedUncommittedPublication: true,
        ...unsafeSnapshot,
      });
      expect(result.status).toBe("attention-required");
      expect(f.store.read("card")?.phase).toBe("attention-required");
    },
  );

  it("resumes an unambiguously prepared publication but blocks mismatched CI and reply outcomes", async () => {
    const publication = fixture("publication");
    expect(
      (await publication.reconcile({ trustedCommitSha: publication.sha }))
        .status,
    ).toBe("resume");

    const ci = fixture("ci");
    expect(
      (
        await ci.reconcile({
          ciEvaluation: {
            status: "passed",
            expectedHeadSha: "b".repeat(40),
            expectedCheckNames: ["Build"],
          },
        })
      ).status,
    ).toBe("attention-required");

    const feedback = fixture("human-feedback");
    expect(
      (
        await feedback.reconcile({
          uncertainReplyIds: ["conversation-comment:1"],
        })
      ).status,
    ).toBe("attention-required");
  });

  it("completes only when merged PR and Done card snapshots agree", async () => {
    const f = fixture("done");
    expect((await f.reconcile()).status).toBe("complete");
    const mismatch = fixture("done");
    expect((await mismatch.reconcile({ trelloListId: "review" })).status).toBe(
      "attention-required",
    );
  });

  it.each(["MERGED", "CLOSED"] as const)(
    "preserves terminal %s observation while reconciling a Human Review wait",
    async (state) => {
      const f = fixture("human-feedback");
      await f.reconcile({ trelloListId: "working" });
      const terminal = await f.reconcile(
        {
          trelloListId: "review",
          pullRequest: {
            number: 1,
            url: "https://github.com/o/r/pull/1",
            headSha: f.sha,
            state,
          },
        },
        () => Date.now() + 5_000,
      );
      expect(terminal.status).toBe("terminal-observed");
      expect(terminal.record.recoveryWait).toBeDefined();
    },
  );

  it("persists manual-move wait and only resumes after the complete safety snapshot passes", async () => {
    const f = fixture("validation");
    const moved = await f.reconcile({ trelloListId: "review" });
    expect(moved.status).toBe("waiting");
    expect(moved.record.recoveryWait).toMatchObject({
      reason: expect.stringContaining("unexpected list"),
      attempts: 1,
    });
    const alternating = await f.reconcile(
      { trelloListId: "other" },
      () => Date.now() + 2_000,
    );
    expect(alternating.status).toBe("waiting");
    expect(alternating.record.recoveryWait?.attempts).toBe(2);
    expect(alternating.record.recoveryWait?.notificationId).toBe(
      moved.record.recoveryWait?.notificationId,
    );
    const blocked = await f.reconcile(
      { trelloListId: "working", worktreeRebaseActive: true },
      () => Date.now() + 10_000,
    );
    expect(blocked.status).toBe("attention-required");
    expect(f.store.read("card")?.phase).toBe("attention-required");
    expect(f.store.read("card")?.recoveryWait).toBeUndefined();
    expect(blocked.status).not.toBe("resume");
  });

  it("keeps a published feedback-correction checkpoint in Human Review and still protects manual moves", async () => {
    const f = fixture("validation");
    const initial = f.store.read("card");
    if (initial === null) throw new Error("Expected validation checkpoint");
    f.store.compareAndSwap("card", initial.revision, {
      ...initial,
      pullRequest: {
        number: 1,
        url: "https://github.com/o/r/pull/1",
        headSha: f.sha,
      },
      feedbackRemediation: {
        operationId: "feedback:published-correction",
        status: "changed",
        headSha: f.sha,
        ledgerRevision: 1,
      },
      revision: initial.revision + 1,
    });
    const prSnapshot = {
      pullRequest: {
        number: 1,
        url: "https://github.com/o/r/pull/1",
        headSha: f.sha,
        state: "OPEN" as const,
      },
      trustedCommitSha: f.sha,
    };

    const unexpectedWorkingMove = await f.reconcile({
      ...prSnapshot,
      trelloListId: "working",
    });
    expect(unexpectedWorkingMove.status).toBe("waiting");
    expect(unexpectedWorkingMove.record.recoveryWait?.kind).toBe("manual-move");

    const returnedReviewCard = await f.reconcile(
      { ...prSnapshot, trelloListId: "review" },
      () => Date.now() + 5_000,
    );
    expect(returnedReviewCard.status).toBe("resume");
    expect(returnedReviewCard.record.phase).toBe("validation");
    expect(returnedReviewCard.record.recoveryWait).toBeUndefined();
  });

  it("keeps a failed-CI checkpoint blocked when its OPEN PR card is in Backlog, then verifies safe return", async () => {
    const f = fixture("ci");
    const moved = await f.reconcile({
      trelloListId: "backlog",
      ciEvaluation: {
        status: "failed",
        expectedHeadSha: f.sha,
        expectedCheckNames: ["Build"],
        failures: [],
      },
    });
    expect(moved.status).toBe("waiting");
    expect(moved.record.phase).toBe("ci");
    expect(moved.record.recoveryWait?.kind).toBe("manual-move");

    const restored = await f.reconcile(
      {
        trelloListId: "review",
        ciEvaluation: {
          status: "failed",
          expectedHeadSha: f.sha,
          expectedCheckNames: ["Build"],
          failures: [],
        },
      },
      () => Date.now() + 5_000,
    );
    expect(restored.status).toBe("resume");
    expect(restored.record.phase).toBe("ci");
    expect(restored.record.recoveryWait).toBeUndefined();
  });

  it("fails closed on malformed durable records and untrusted local commits", async () => {
    const malformed = fixture();
    fs.writeFileSync(
      path.join(root, "state", "task-executions", "project", "card.json"),
      "{broken",
      "utf8",
    );
    await expect(malformed.reconcile()).rejects.toThrow(
      "Could not parse task execution record",
    );

    const committed = fixture();
    const mismatch = await committed.reconcile({
      trustedCommitSha: "c".repeat(40),
      worktreeHeadSha: "b".repeat(40),
    });
    expect(mismatch.status).toBe("attention-required");
  });

  it("requires recorded setup state and preserves uncertain setup outcomes for attention", async () => {
    const legacyRecord = fixture("planning");
    legacyRecord.project.repository.setupCommand = "yarn install";
    const missingSetupState = await legacyRecord.reconcile();
    expect(missingSetupState).toMatchObject({
      status: "attention-required",
      reason:
        "Repository setup state is missing, changed, or has an uncertain outcome",
    });

    const interruptedSetup = fixture("planning");
    interruptedSetup.project.repository.setupCommand = "yarn install";
    const current = interruptedSetup.store.read("card");
    expect(current).not.toBeNull();
    interruptedSetup.store.compareAndSwap("card", current!.revision, {
      ...current!,
      setup: { command: "yarn install", status: "active" },
      revision: current!.revision + 1,
      updatedAt: "2026-10-24T09:00:01.000Z",
    });
    const setupOutcome = await interruptedSetup.reconcile();
    expect(setupOutcome).toMatchObject({
      status: "attention-required",
      reason:
        "Repository setup state is missing, changed, or has an uncertain outcome",
    });
    expect(interruptedSetup.store.read("card")?.setup?.status).toBe("active");
  });
});
