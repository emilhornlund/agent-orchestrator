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
import {
  ProcessExecutionError,
  configureProcessRuntime,
} from "../src/process/process-runtime.js";
import {
  MAX_GITHUB_RECONCILIATION_ATTEMPTS,
  RetryableGitHubReconciliationError,
} from "../src/orchestrator/github-reconciliation-error.js";
import { runOrchestrator } from "../src/orchestrator/run-orchestrator.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import type { TrelloClient } from "../src/trello/trello-client.js";
import type { GitHubClient } from "../src/github/github-client.js";
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
  it("persists actual worker retry/exhaustion decisions and process artifacts across restart and daily-log expiry", async () => {
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

      const fakeGit = path.join(binRoot, "git");
      fs.writeFileSync(
        fakeGit,
        "#!/bin/sh\nprintf 'safe-stdout-marker\\n'\nprintf 'safe-stderr-marker\\n' >&2\nexit 29\n",
      );
      fs.chmodSync(fakeGit, 0o700);
      process.env.PATH = `${binRoot}${path.delimiter}${priorPath ?? ""}`;
      process.env.VITEST = "false";
      configureLoggerRuntime(storageRoot);
      configureProcessRuntime({
        runtimeRoot: storageRoot,
        signal: new AbortController().signal,
      });

      let invocations = 0;
      const trello = {
        getCards: vi.fn(async () => {
          // The exhausted production worker is now in its blocked recovery wait.
          controller.abort();
          return [];
        }),
      } as unknown as TrelloClient;
      const controller = new AbortController();
      vi.mocked(pollProject).mockImplementation(async () => {
        invocations += 1;
        let processFailure: unknown;
        try {
          await new GitClient().getStatus(repositoryPath);
        } catch (error) {
          processFailure = error;
        }
        expect(processFailure).toBeInstanceOf(ProcessExecutionError);
        throw new RetryableGitHubReconciliationError(
          project.id,
          "diagnostic-card",
          "pull request state",
          processFailure,
          "synthetic reconciliation failure",
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
        {} as GitHubClient,
        {} as OpenCodeClient,
        {} as CommandRunner,
        config,
        controller.signal,
        undefined,
        undefined,
        new Map([[project.id, context]]),
      );
      expect(invocations).toBe(MAX_GITHUB_RECONCILIATION_ATTEMPTS);

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
      expect(diagnosticEvents).toHaveLength(
        MAX_GITHUB_RECONCILIATION_ATTEMPTS + 1,
      );
      expect(diagnosticEvents.map((event) => event.summary)).toEqual([
        ...Array.from(
          { length: MAX_GITHUB_RECONCILIATION_ATTEMPTS - 1 },
          (_, index) =>
            expect.objectContaining({
              code: "recovery-deferred",
              category: "external-operation",
              recovery: "retry-scheduled",
              attempt: index + 1,
              maximumAttempts: MAX_GITHUB_RECONCILIATION_ATTEMPTS,
            }),
        ),
        expect.objectContaining({
          code: "recovery-deferred",
          category: "external-operation",
          recovery: "state-preserved",
          attempt: MAX_GITHUB_RECONCILIATION_ATTEMPTS,
          maximumAttempts: MAX_GITHUB_RECONCILIATION_ATTEMPTS,
        }),
        expect.objectContaining({
          code: "process-failed",
          category: "process",
          recovery: "state-preserved",
        }),
      ]);

      const processDiagnostic = diagnosticEvents.find(
        (event) => event.summary.code === "process-failed",
      )!;
      const artifactReference = (
        processDiagnostic.summary.artifactReferences as string[]
      )[0]!;
      expect(artifactReference).toMatch(
        /^process-executions\/[0-9a-f-]+\/stderr\.txt$/,
      );
      const executionDirectory = path.join(
        storageRoot,
        "artifacts",
        encodeURIComponent(project.id),
        encodeURIComponent("diagnostic-card"),
        encodeURIComponent(record.attemptId),
        artifactReference,
      );
      expect(fs.readFileSync(executionDirectory, "utf8")).toContain(
        "safe-stderr-marker",
      );
      expect(
        fs.readFileSync(
          path.join(path.dirname(executionDirectory), "stdout.txt"),
          "utf8",
        ),
      ).toContain("safe-stdout-marker");
      expect(history).not.toContain("safe-stderr-marker");
      expect(history).not.toContain("safe-stdout-marker");

      const dailyLog = path.join(
        storageRoot,
        "orchestrator-logs",
        `orchestrator-${new Date().toISOString().slice(0, 10)}.log`,
      );
      const dailyContents = fs.readFileSync(dailyLog, "utf8");
      expect(dailyContents).toContain(
        "Retryable GitHub reconciliation attempt 1/3",
      );
      expect(dailyContents).toContain("retry threshold exhausted");
      expect(dailyContents).toContain(artifactReference);
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
        expect.arrayContaining([
          ...Array.from(
            { length: MAX_GITHUB_RECONCILIATION_ATTEMPTS - 1 },
            (_, index) =>
              expect.objectContaining({
                code: "recovery-deferred",
                recovery: "retry-scheduled",
                attempt: index + 1,
                maximumAttempts: MAX_GITHUB_RECONCILIATION_ATTEMPTS,
              }),
          ),
          expect.objectContaining({
            code: "recovery-deferred",
            recovery: "state-preserved",
            attempt: MAX_GITHUB_RECONCILIATION_ATTEMPTS,
          }),
          expect.objectContaining({
            code: "process-failed",
            recovery: "state-preserved",
            artifactReferences: [artifactReference],
          }),
        ]),
      );
      expect(
        restarted.decisions.some(
          (summary) =>
            Array.isArray(summary.artifactReferences) &&
            summary.artifactReferences[0] === artifactReference,
        ),
      ).toBe(true);
    } finally {
      process.env.PATH = priorPath;
      if (priorVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = priorVitest;
      await lease.release();
    }
  }, 30_000);
});
