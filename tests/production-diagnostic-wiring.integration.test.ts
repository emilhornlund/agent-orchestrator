import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Config, ProjectConfig } from "../src/config/config.js";
import {
  acquireProjectOwnership,
  provisionCoordinationNamespace,
} from "../src/coordination/project-ownership.js";
import { verifyAndPinProjects } from "../src/coordination/project-registry.js";
import { GitClient } from "../src/git/git-client.js";
import { configureLoggerRuntime } from "../src/logging/logger.js";
import { cleanupLogRetention } from "../src/logging/log-retention.js";
import { configureProcessRuntime } from "../src/process/process-runtime.js";
import { runOrchestrator } from "../src/orchestrator/run-orchestrator.js";
import { observeTaskSessionReviewCards } from "../src/orchestrator/observe-task-session-review-cards.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import type { TrelloClient } from "../src/trello/trello-client.js";
import {
  GitHubClient,
  MalformedGitHubResponseError,
  isRetryableGitHubError,
  type GitHubClient as GitHubClientType,
} from "../src/github/github-client.js";
import {
  githubReconciliationError,
  MAX_GITHUB_RECONCILIATION_ATTEMPTS,
  RetryableGitHubReconciliationError,
} from "../src/orchestrator/github-reconciliation-error.js";
import type { OpenCodeClient } from "../src/opencode/opencode-client.js";
import type { CommandRunner } from "../src/process/command-runner.js";

vi.mock("../src/orchestrator/poll-project.js", () => ({
  pollProject: vi.fn(),
}));

const { pollProject } = await import("../src/orchestrator/poll-project.js");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function projectConfig(
  id: string,
  repositoryPath: string,
  worktreeRoot: string,
): ProjectConfig {
  return {
    id,
    autoMerge: false,
    trello: {
      boardId: `board-${id}`,
      backlogListId: `backlog-${id}`,
      readyListId: `ready-${id}`,
      workingListId: `working-${id}`,
      reviewListId: `review-${id}`,
      failedListId: `failed-${id}`,
      doneListId: `done-${id}`,
      refinementLabelId: `refinement-${id}`,
      featureLabelId: `feature-${id}`,
      improvementLabelId: `improvement-${id}`,
      bugLabelId: `bug-${id}`,
    },
    repository: {
      path: repositoryPath,
      github: `owner/${id}`,
      defaultBranch: "main",
      worktreeRoot,
      gitIdentity: { name: "Test", email: "test@example.com" },
    },
    opencode: {
      refinement: { model: "test", variant: "test" },
      implementation: { model: "test", variant: "test" },
      review: { model: "test", variant: "test" },
      remediation: { model: "test", variant: "test", maxPasses: 1 },
      commit: { model: "test", variant: "test" },
      timeoutMinutes: 1,
    },
  };
}

describe("production typed diagnostic evidence", () => {
  it("keeps malformed gh response artifacts out of logs and history without retrying", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-diagnostics-"));
    roots.push(root);
    const coordinationRoot = path.join(root, "coordination");
    const storageRoot = path.join(root, "storage");
    const repositoryPath = path.join(root, "repository");
    const worktreeRoot = path.join(root, "worktrees");
    const binRoot = path.join(root, "bin");
    for (const directory of [
      coordinationRoot,
      storageRoot,
      repositoryPath,
      worktreeRoot,
      binRoot,
    ])
      fs.mkdirSync(directory, { recursive: true });

    const project = projectConfig(
      "diagnostic-project",
      repositoryPath,
      worktreeRoot,
    );
    provisionCoordinationNamespace(coordinationRoot, "diagnostic-test");
    const config = {
      workflow: {
        pollIntervalSeconds: 0.001,
        logRetentionDays: 1,
        contextRetentionDays: 1,
        contextRoot: storageRoot,
        coordinationRoot,
        coordinationNamespaceId: "diagnostic-test",
      },
      projects: [project],
    } as Config;
    const lease = await acquireProjectOwnership(
      coordinationRoot,
      {
        trelloBoardId: project.trello.boardId,
        githubRepository: project.repository.github,
      },
      "diagnostic-test",
    );
    const priorPath = process.env.PATH;
    const priorVitest = process.env.VITEST;
    try {
      const hostPin = (await verifyAndPinProjects(config, [lease]))[0]!;
      const pinned = {
        integrationId: hostPin.integrationId,
        projectId: project.id,
        boardId: project.trello.boardId,
        lists: {
          ready: project.trello.readyListId,
          working: project.trello.workingListId,
          review: project.trello.reviewListId,
          failed: project.trello.failedListId,
          done: project.trello.doneListId,
          backlog: project.trello.backlogListId,
        },
        repository: hostPin.repository.github,
        repositoryPath: hostPin.repository.path,
        worktreeRoot: hostPin.repository.worktreeRoot,
        storageRoot: hostPin.storageRoot,
      };
      const authority = await ProjectRunAuthority.createPreparingAttempt({
        projectId: project.id,
        cardId: "diagnostic-card",
        taskKind: "refinement",
        pinned,
        projectLease: lease,
        coordinationRoot,
        attemptId: "diagnostic-attempt",
      });
      authority.claim();

      const rawMarker = "GH_INVALID_JSON_RAW_OUTPUT_CANARY_4E21";
      const fakeGh = path.join(binRoot, "gh");
      fs.writeFileSync(
        fakeGh,
        `#!/bin/sh\nprintf '[{${rawMarker}\\n'\nprintf 'safe-stderr-marker\\n' >&2\nexit 0\n`,
      );
      fs.chmodSync(fakeGh, 0o700);
      process.env.PATH = `${binRoot}${path.delimiter}${priorPath ?? ""}`;
      process.env.VITEST = "false";
      configureLoggerRuntime(storageRoot);
      configureProcessRuntime({
        runtimeRoot: storageRoot,
        signal: new AbortController().signal,
      });
      const controller = new AbortController();
      const consoleOutput: string[] = [];
      for (const method of ["log", "warn", "error"] as const)
        vi.spyOn(console, method).mockImplementation((...values: unknown[]) => {
          consoleOutput.push(values.join(" "));
          if (
            method === "error" &&
            values
              .join(" ")
              .includes("Could not reconcile the pull request state")
          )
            controller.abort();
        });

      const taskStore = new TaskExecutionStore(storageRoot, project);
      taskStore.create({
        version: 1,
        projectId: project.id,
        cardId: "diagnostic-card",
        phase: "human-feedback",
        primarySessionId: "diagnostic-session",
        sessionCreationStatus: "bound",
        expectedBranch: "agent/diagnostic-card",
        pullRequest: {
          number: 7,
          url: "https://github.com/owner/diagnostic-project/pull/7",
          headSha: "a".repeat(40),
        },
        operationKey: "diagnostic-review",
        revision: 1,
        retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const monitoringGithub = Object.assign(new GitHubClient(), {
        findPullRequestState: vi.fn(async () => ({
          url: "https://github.com/owner/diagnostic-project/pull/7",
          state: "OPEN" as const,
          mergedAt: null,
          headRefOid: "a".repeat(40),
        })),
        getCiObservations: vi.fn(async () => ({
          headSha: "a".repeat(40),
          checks: [],
          expectationSources: [],
        })),
        getPullRequestConversationComments: vi.fn(async () => []),
      });
      let invocations = 0;
      let observedFailure: MalformedGitHubResponseError | undefined;
      const trello = {
        getCards: vi.fn(async () => []),
      } as unknown as TrelloClient;
      vi.mocked(pollProject).mockImplementation(async () => {
        invocations += 1;
        let processFailure: unknown;
        try {
          await observeTaskSessionReviewCards({
            project,
            cards: [
              {
                id: "diagnostic-card",
                name: "Diagnostic card",
                desc: "",
                idList: project.trello.reviewListId,
                idLabels: [],
                url: "https://trello.example/diagnostic-card",
              },
            ],
            taskRecordStore: taskStore,
            github: monitoringGithub,
          });
        } catch (error) {
          processFailure = error;
        }
        expect(processFailure).toBeInstanceOf(MalformedGitHubResponseError);
        expect((processFailure as Error).message).not.toContain(rawMarker);
        expect(processFailure).toMatchObject({
          executionId: expect.stringMatching(/^[0-9a-f-]{36}$/iu),
          stdoutArtifactReference: expect.stringMatching(
            /^process-executions\/[0-9a-f-]+\/stdout\.txt$/,
          ),
        });
        observedFailure = processFailure as MalformedGitHubResponseError;
        throw githubReconciliationError(
          project.id,
          "diagnostic-card",
          "pull request state",
          processFailure,
          "Could not reconcile the pull request state",
          { reconciliationListId: project.trello.reviewListId },
        );
      });

      const context = {
        authority,
        projectLease: lease,
        pinned,
        coordinationRoot,
      };
      await runOrchestrator(
        trello,
        {} as GitClient,
        {} as GitHubClientType,
        {} as OpenCodeClient,
        {} as CommandRunner,
        config,
        controller.signal,
        undefined,
        undefined,
        new Map([[project.id, context]]),
      );
      expect(invocations).toBe(1);

      const record = authority.store.read()!;
      const eventPath = path.join(
        storageRoot,
        "history",
        encodeURIComponent(project.id),
        encodeURIComponent("diagnostic-card"),
        encodeURIComponent(record.attemptId),
        "events.jsonl",
      );
      const history = fs.readFileSync(eventPath, "utf8");
      const diagnosticEvents = history
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              type: string;
              summary: Record<string, unknown>;
            },
        )
        .filter(
          (event) =>
            event.type === "workflow-diagnostic" &&
            typeof event.summary.code === "string",
        );
      expect(diagnosticEvents).toHaveLength(1);
      expect(diagnosticEvents[0]?.summary).toEqual({
        code: "process-failed",
        category: "process",
        recovery: "manual-review",
        artifactReferences: [observedFailure!.stdoutArtifactReference],
      });
      const artifactReference = observedFailure!.stdoutArtifactReference!;
      expect(artifactReference).toMatch(
        /^process-executions\/[0-9a-f-]+\/stdout\.txt$/,
      );
      const executionDirectory = path.join(
        storageRoot,
        "artifacts",
        encodeURIComponent(project.id),
        encodeURIComponent("diagnostic-card"),
        encodeURIComponent(record.attemptId),
        artifactReference,
      );
      const stdoutArtifact = fs.readFileSync(executionDirectory, "utf8");
      expect(stdoutArtifact).toContain(rawMarker);
      expect(
        fs.readFileSync(
          path.join(path.dirname(executionDirectory), "stderr.txt"),
          "utf8",
        ),
      ).toContain("safe-stderr-marker");
      expect(history).not.toContain(rawMarker);

      const dailyLog = path.join(
        storageRoot,
        "orchestrator-logs",
        `orchestrator-${new Date().toISOString().slice(0, 10)}.log`,
      );
      const dailyContents = fs.readFileSync(dailyLog, "utf8");
      expect(dailyContents).not.toContain("Retryable GitHub reconciliation");
      expect(dailyContents).toContain(
        "Could not reconcile the pull request state",
      );
      expect(dailyContents).not.toContain(rawMarker);
      expect(consoleOutput.join(" ")).not.toContain(rawMarker);
      const oldDailyDate = new Date("2020-01-01T00:00:00.000Z");
      fs.utimesSync(dailyLog, oldDailyDate, oldDailyDate);

      // Complete this real refinement through its authoritative transition so
      // retention may remove its old daily log without relying on a fake record.
      await authority.completeRefinement({
        observationId: "diagnostic-refinement-complete",
        observedAt: new Date().toISOString(),
        trelloObservationId: "diagnostic-card-observed",
        trelloVerifiedAt: new Date().toISOString(),
      });
      const terminalRecord = authority.store.read()!;
      cleanupLogRetention(1, new Date("2026-03-01T00:00:00.000Z"), [
        storageRoot,
      ]);
      expect(fs.existsSync(dailyLog)).toBe(false);
      expect(fs.existsSync(eventPath)).toBe(true);

      const childScript = `
        import fs from "node:fs";
        import path from "node:path";
        import { RunStore } from ${JSON.stringify(path.resolve("src/task-session/run-store.ts"))};
        const payload = JSON.parse(process.argv[1]);
        const lease = { integrationId: payload.pinned.integrationId, instanceId: payload.owner.instanceId, token: payload.owner.token, assertHeld() {} };
        const store = new RunStore(payload.pinned.storageRoot, payload.attemptId, payload.pinned, lease);
        const record = store.read();
        const history = fs.readFileSync(payload.eventPath, "utf8").trim().split("\\n").map(line => JSON.parse(line)).filter(event => typeof event.summary?.code === "string");
        process.stdout.write(JSON.stringify({ lifecycle: record.lifecycle, decisions: history.filter(event => event.type === "workflow-diagnostic").map(event => event.summary) }));
      `;
      const restarted = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            childScript,
            JSON.stringify({
              pinned,
              owner: terminalRecord.owner,
              attemptId: terminalRecord.attemptId,
              eventPath,
            }),
          ],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            env: { ...process.env, VITEST: "false" },
          },
        ),
      ) as { lifecycle: string; decisions: Array<Record<string, unknown>> };
      expect(restarted.lifecycle).toBe(terminalRecord.lifecycle);
      expect(restarted.decisions).toEqual(
        diagnosticEvents.map((event) => event.summary),
      );
      expect(restarted.decisions).toEqual(
        diagnosticEvents.map((event) => event.summary),
      );
    } finally {
      vi.restoreAllMocks();
      process.env.PATH = priorPath;
      if (priorVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = priorVitest;
      await lease.release();
    }
  }, 30_000);

  it("persists bounded retries for a transient gh HTTP 503 without leaking stderr", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "worker-retry-diagnostics-"),
    );
    roots.push(root);
    const coordinationRoot = path.join(root, "coordination");
    const storageRoot = path.join(root, "storage");
    const repositoryPath = path.join(root, "repository");
    const worktreeRoot = path.join(root, "worktrees");
    const binRoot = path.join(root, "bin");
    for (const directory of [
      coordinationRoot,
      storageRoot,
      repositoryPath,
      worktreeRoot,
      binRoot,
    ])
      fs.mkdirSync(directory, { recursive: true });

    const project = projectConfig(
      "retry-diagnostic-project",
      repositoryPath,
      worktreeRoot,
    );
    provisionCoordinationNamespace(coordinationRoot, "retry-diagnostic-test");
    const config = {
      workflow: {
        pollIntervalSeconds: 0.001,
        logRetentionDays: 1,
        contextRetentionDays: 1,
        contextRoot: storageRoot,
        coordinationRoot,
        coordinationNamespaceId: "retry-diagnostic-test",
      },
      projects: [project],
    } as Config;
    const lease = await acquireProjectOwnership(
      coordinationRoot,
      {
        trelloBoardId: project.trello.boardId,
        githubRepository: project.repository.github,
      },
      "retry-diagnostic-test",
    );
    const priorPath = process.env.PATH;
    const priorVitest = process.env.VITEST;
    try {
      const hostPin = (await verifyAndPinProjects(config, [lease]))[0]!;
      const pinned = {
        integrationId: hostPin.integrationId,
        projectId: project.id,
        boardId: project.trello.boardId,
        lists: {
          ready: project.trello.readyListId,
          working: project.trello.workingListId,
          review: project.trello.reviewListId,
          failed: project.trello.failedListId,
          done: project.trello.doneListId,
          backlog: project.trello.backlogListId,
        },
        repository: hostPin.repository.github,
        repositoryPath: hostPin.repository.path,
        worktreeRoot: hostPin.repository.worktreeRoot,
        storageRoot: hostPin.storageRoot,
      };
      const authority = await ProjectRunAuthority.createPreparingAttempt({
        projectId: project.id,
        cardId: "retry-diagnostic-card",
        taskKind: "refinement",
        pinned,
        projectLease: lease,
        coordinationRoot,
        attemptId: "retry-diagnostic-attempt",
      });
      authority.claim();

      const rawMarker = "GH_HTTP_503_STDERR_CANARY_91BC";
      const safeServiceError = "HTTP 503: safe GitHub temporary service error";
      const fakeGh = path.join(binRoot, "gh");
      fs.writeFileSync(
        fakeGh,
        `#!/bin/sh\nprintf '%s\\n' '${safeServiceError} ${rawMarker}' >&2\nexit 1\n`,
      );
      fs.chmodSync(fakeGh, 0o700);
      process.env.PATH = `${binRoot}${path.delimiter}${priorPath ?? ""}`;
      process.env.VITEST = "false";
      configureLoggerRuntime(storageRoot);
      configureProcessRuntime({
        runtimeRoot: storageRoot,
        signal: new AbortController().signal,
      });
      const consoleOutput: string[] = [];
      for (const method of ["log", "warn", "error"] as const)
        vi.spyOn(console, method).mockImplementation((...values: unknown[]) => {
          consoleOutput.push(values.join(" "));
        });

      const taskStore = new TaskExecutionStore(storageRoot, project);
      taskStore.create({
        version: 1,
        projectId: project.id,
        cardId: "retry-diagnostic-card",
        phase: "human-feedback",
        primarySessionId: "retry-diagnostic-session",
        sessionCreationStatus: "bound",
        expectedBranch: "agent/retry-diagnostic-card",
        pullRequest: {
          number: 9,
          url: "https://github.com/owner/retry-diagnostic-project/pull/9",
          headSha: "b".repeat(40),
        },
        operationKey: "retry-diagnostic-review",
        revision: 1,
        retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const controller = new AbortController();
      let invocations = 0;
      const processFailures: Error[] = [];
      const trello = {
        getCards: vi.fn(async () => {
          if (invocations >= MAX_GITHUB_RECONCILIATION_ATTEMPTS)
            controller.abort();
          return [];
        }),
      } as unknown as TrelloClient;
      vi.mocked(pollProject).mockImplementation(async () => {
        invocations += 1;
        let processFailure: unknown;
        try {
          await observeTaskSessionReviewCards({
            project,
            cards: [
              {
                id: "retry-diagnostic-card",
                name: "Retry diagnostic card",
                desc: "",
                idList: project.trello.reviewListId,
                idLabels: [],
                url: "https://trello.example/retry-diagnostic-card",
              },
            ],
            taskRecordStore: taskStore,
            github: new GitHubClient(),
          });
        } catch (error) {
          processFailure = error;
        }
        expect(processFailure).toBeInstanceOf(Error);
        expect(isRetryableGitHubError(processFailure)).toBe(true);
        const reconciliationFailure = githubReconciliationError(
          project.id,
          "retry-diagnostic-card",
          "pull request state",
          processFailure,
          "Could not reconcile the pull request state",
          { reconciliationListId: project.trello.reviewListId },
        );
        expect(reconciliationFailure).toBeInstanceOf(
          RetryableGitHubReconciliationError,
        );
        expect(reconciliationFailure.cause).toBe(processFailure);
        processFailures.push(processFailure as Error);
        if (invocations >= MAX_GITHUB_RECONCILIATION_ATTEMPTS)
          controller.abort();
        throw reconciliationFailure;
      });

      const context = {
        authority,
        projectLease: lease,
        pinned,
        coordinationRoot,
      };
      await runOrchestrator(
        trello,
        {} as GitClient,
        {} as GitHubClientType,
        {} as OpenCodeClient,
        {} as CommandRunner,
        config,
        controller.signal,
        undefined,
        undefined,
        new Map([[project.id, context]]),
      );

      expect(invocations).toBe(MAX_GITHUB_RECONCILIATION_ATTEMPTS);
      expect(processFailures).toHaveLength(MAX_GITHUB_RECONCILIATION_ATTEMPTS);
      const record = authority.store.read()!;
      const eventPath = path.join(
        storageRoot,
        "history",
        encodeURIComponent(project.id),
        encodeURIComponent("retry-diagnostic-card"),
        encodeURIComponent(record.attemptId),
        "events.jsonl",
      );
      const history = fs.readFileSync(eventPath, "utf8");
      const allDiagnostics = history
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              type: string;
              summary: Record<string, unknown>;
            },
        );
      const retryDecisions = allDiagnostics.filter(
        (event) =>
          event.type === "workflow-diagnostic" &&
          event.summary.code === "recovery-deferred",
      );
      expect(retryDecisions.map((event) => event.summary)).toEqual([
        {
          code: "recovery-deferred",
          category: "external-operation",
          recovery: "retry-scheduled",
          attempt: 1,
          maximumAttempts: 3,
          artifactReferences: [],
        },
        {
          code: "recovery-deferred",
          category: "external-operation",
          recovery: "retry-scheduled",
          attempt: 2,
          maximumAttempts: 3,
          artifactReferences: [],
        },
        {
          code: "recovery-deferred",
          category: "external-operation",
          recovery: "state-preserved",
          attempt: 3,
          maximumAttempts: 3,
          artifactReferences: [],
        },
      ]);
      const stderrArtifactReferences = processFailures.map((failure) => {
        expect(failure.message).not.toContain(rawMarker);
        expect(failure.message).toContain("process-executions/");
        const stderrArtifactReference = failure.message.match(
          /process-executions\/[0-9a-f-]+\/stderr\.txt/,
        )?.[0];
        expect(stderrArtifactReference).toMatch(
          /^process-executions\/[0-9a-f-]+\/stderr\.txt$/,
        );
        const stderrPath = path.join(
          storageRoot,
          "artifacts",
          encodeURIComponent(project.id),
          encodeURIComponent("retry-diagnostic-card"),
          encodeURIComponent(record.attemptId),
          stderrArtifactReference!,
        );
        const stderr = fs.readFileSync(stderrPath, "utf8");
        expect(stderr).toContain(`${safeServiceError} ${rawMarker}`);
        return stderrArtifactReference!;
      });
      expect(new Set(stderrArtifactReferences).size).toBe(
        MAX_GITHUB_RECONCILIATION_ATTEMPTS,
      );
      const persistedArtifactReferences = allDiagnostics.flatMap((event) =>
        Array.isArray(event.summary?.artifactReferences)
          ? (event.summary.artifactReferences as string[])
          : [],
      );
      expect(persistedArtifactReferences).toEqual(
        expect.arrayContaining([stderrArtifactReferences.at(-1)]),
      );
      const dailyLog = path.join(
        storageRoot,
        "orchestrator-logs",
        `orchestrator-${new Date().toISOString().slice(0, 10)}.log`,
      );
      const dailyContents = fs.readFileSync(dailyLog, "utf8");
      expect(dailyContents).toContain(
        "Retryable GitHub reconciliation attempt 1/3",
      );
      expect(dailyContents).toContain(
        "Retryable GitHub reconciliation attempt 3/3",
      );
      expect(dailyContents).not.toContain(rawMarker);
      expect(consoleOutput.join(" ")).not.toContain(rawMarker);
      expect(history).not.toContain(rawMarker);
      const oldDailyDate = new Date("2020-01-01T00:00:00.000Z");
      fs.utimesSync(dailyLog, oldDailyDate, oldDailyDate);

      await authority.completeRefinement({
        observationId: "retry-diagnostic-refinement-complete",
        observedAt: new Date().toISOString(),
        trelloObservationId: "retry-diagnostic-card-observed",
        trelloVerifiedAt: new Date().toISOString(),
      });
      const terminalRecord = authority.store.read()!;
      cleanupLogRetention(1, new Date("2026-03-01T00:00:00.000Z"), [
        storageRoot,
      ]);
      expect(fs.existsSync(dailyLog)).toBe(false);
      expect(fs.existsSync(eventPath)).toBe(true);

      const childScript = `
        import fs from "node:fs";
        import { RunStore } from ${JSON.stringify(path.resolve("src/task-session/run-store.ts"))};
        const payload = JSON.parse(process.argv[1]);
        const lease = { integrationId: payload.pinned.integrationId, instanceId: payload.owner.instanceId, token: payload.owner.token, assertHeld() {} };
        const store = new RunStore(payload.pinned.storageRoot, payload.attemptId, payload.pinned, lease);
        const record = store.read();
        const decisions = fs.readFileSync(payload.eventPath, "utf8").trim().split("\\n").map(line => JSON.parse(line)).filter(event => event.type === "workflow-diagnostic" && event.summary?.code === "recovery-deferred").map(event => event.summary);
        process.stdout.write(JSON.stringify({ lifecycle: record.lifecycle, decisions }));
      `;
      const restarted = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            childScript,
            JSON.stringify({
              pinned,
              owner: terminalRecord.owner,
              attemptId: terminalRecord.attemptId,
              eventPath,
            }),
          ],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            env: { ...process.env, VITEST: "false" },
          },
        ),
      ) as { lifecycle: string; decisions: Array<Record<string, unknown>> };
      expect(restarted.lifecycle).toBe(terminalRecord.lifecycle);
      expect(restarted.decisions).toEqual(
        retryDecisions.map((event) => event.summary),
      );
    } finally {
      vi.restoreAllMocks();
      process.env.PATH = priorPath;
      if (priorVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = priorVitest;
      await lease.release();
    }
  }, 30_000);
});
