import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import type { CiCheckEvaluation } from "../src/github/evaluate-ci-checks.js";
import { runTaskSessionCiRepairs } from "../src/task-session/run-task-session-ci-repairs.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { ciRepairEventId } from "../src/task-session/ci-repair-event-id.js";

let root: string;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ci-repair-"));
  const project = {
    id: "project",
    repository: {
      path: path.join(root, "repo"),
      worktreeRoot: path.join(root, "worktrees"),
    },
  } as ProjectConfig;
  fs.mkdirSync(project.repository.path, { recursive: true });
  const store = new TaskExecutionStore(path.join(root, "state"), project);
  const sha = "a".repeat(40);
  store.create({
    version: 1,
    projectId: "project",
    cardId: "card",
    phase: "ci",
    primarySessionId: "session",
    sessionCreationStatus: "bound",
    expectedBranch: "agent/card",
    pullRequest: {
      number: 1,
      url: "https://github.com/o/r/pull/1",
      headSha: sha,
    },
    operationKey: "operation",
    revision: 1,
    retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
    createdAt: "2026-10-24T09:00:00.000Z",
    updatedAt: "2026-10-24T09:00:00.000Z",
  });
  const evaluation = (
    headSha: string,
    status: "failed" | "passed",
  ): CiCheckEvaluation =>
    status === "passed"
      ? { status, expectedHeadSha: headSha, expectedCheckNames: ["Build"] }
      : {
          status,
          expectedHeadSha: headSha,
          expectedCheckNames: ["Build"],
          failures: [
            {
              source: "check-run",
              id: 1,
              name: "Build",
              headSha,
              status: "completed",
              conclusion: "failure",
              url: null,
            },
          ],
        };
  const base = {
    store,
    projectId: "project",
    cardId: "card",
    operationKey: "operation",
    expectedPrimarySessionId: "session",
    headSha: sha,
    collectDiagnostics: vi.fn(async () => []),
    repairPrimarySession: vi.fn(async () => undefined),
    rerunLocalGatesAndReview: vi.fn(async () => undefined),
    publishSamePullRequest: vi.fn(async () => "b".repeat(40)),
  };
  return { base, evaluation, sha, store };
}

describe("runTaskSessionCiRepairs", () => {
  it("gives a verified same-head human retry a new queue identity and episode without changing its primary session", async () => {
    const f = fixture();
    const record = f.store.read("card")!;
    const originalEvent = ciRepairEventId(record, f.sha);
    f.store.compareAndSwap("card", record.revision, {
      ...record,
      feedbackRemediation: {
        operationId: "feedback:explicit-retry:revision:2",
        status: "no-op",
        headSha: f.sha,
        ledgerRevision: 1,
      },
      revision: record.revision + 1,
    });
    const retry = f.store.read("card")!;
    expect(ciRepairEventId(retry, f.sha)).not.toBe(originalEvent);
    await runTaskSessionCiRepairs({
      ...f.base,
      maxAttempts: 1,
      observeChecks: async (sha) =>
        f.evaluation(sha, sha === f.sha ? "failed" : "passed"),
    });
    const completed = f.store.read("card")!;
    expect(completed.ciRepair).toMatchObject({
      initiatingEventId: "feedback:explicit-retry:revision:2",
      cycleId: "operation:ci:feedback:explicit-retry:revision:2",
    });
    expect(ciRepairEventId(completed, f.sha)).toBe(
      ciRepairEventId(retry, f.sha),
    );
    expect(f.base.repairPrimarySession).toHaveBeenCalledWith(
      [],
      1,
      "session",
      expect.stringContaining("explicit-retry"),
    );
  });
  it("ends unchanged correction without quality reruns, artificial commits or another pass", async () => {
    const f = fixture();
    const result = await runTaskSessionCiRepairs({
      ...f.base,
      getSourceIdentity: async () => `sha256:${"a".repeat(64)}`,
      observeChecks: async (sha) => f.evaluation(sha, "failed"),
    });
    expect(result).toMatchObject({
      status: "stopped",
      reason: "no-change",
      attempts: 1,
    });
    expect(f.base.rerunLocalGatesAndReview).not.toHaveBeenCalled();
    expect(f.base.publishSamePullRequest).not.toHaveBeenCalled();
    expect(f.store.read("card")).toMatchObject({
      phase: "human-feedback",
      ciRepair: { status: "stopped", stopReason: "no-change" },
    });
  });

  it("publishes available early-finish output once without spending the remaining episode", async () => {
    const f = fixture();
    const result = await runTaskSessionCiRepairs({
      ...f.base,
      repairPrimarySession: async () => ({ finishEarly: true }),
      observeChecks: async (sha) => f.evaluation(sha, "failed"),
    });
    expect(result).toMatchObject({
      status: "stopped",
      reason: "finished-early",
      attempts: 1,
      headSha: "b".repeat(40),
    });
    expect(f.base.publishSamePullRequest).toHaveBeenCalledOnce();
  });
  it("resumes an active final-pass CI repair with its exact durable ID and pass", async () => {
    const f = fixture();
    const operationId = "operation:ci:pass:2";
    const promptArtifact = f.store.writePrimaryResultArtifact(
      `${operationId}:prompt`,
      { prompt: "persisted CI prompt" },
    );
    const diagnostics = [
      {
        name: "Build",
        headSha: f.sha,
        logUrl: null,
        available: true,
        diagnostic: "persisted build failure",
      },
    ];
    const diagnosticsArtifact = f.store.writePrimaryResultArtifact(
      `${operationId}:diagnostics`,
      diagnostics,
    );
    const record = f.store.read("card")!;
    f.store.compareAndSwap("card", record.revision, {
      ...record,
      retryCounters: { ...record.retryCounters, ci: 2 },
      ciRepair: {
        cycleId: "operation:ci",
        headSha: f.sha,
        status: "active",
        activePrimaryOperation: {
          operationId,
          pass: 2,
          promptArtifact,
          diagnosticsArtifact,
        },
      },
      revision: record.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    const next = "b".repeat(40);
    const observeChecks = vi.fn(async (sha: string) =>
      f.evaluation(sha, sha === f.sha ? "failed" : "passed"),
    );
    const result = await runTaskSessionCiRepairs({
      ...f.base,
      observeChecks,
      publishSamePullRequest: async () => next,
    });
    expect(result).toMatchObject({
      status: "passed",
      attempts: 2,
      headSha: next,
    });
    expect(f.base.repairPrimarySession).toHaveBeenCalledWith(
      diagnostics,
      2,
      "session",
      operationId,
    );
    expect(observeChecks).toHaveBeenCalledExactlyOnceWith(next);
    expect(f.store.read("card")?.ciRepair?.cycleId).toBe("operation:ci");
  });

  it("waits on queued checks without invoking repair", async () => {
    const f = fixture();
    const result = await runTaskSessionCiRepairs({
      ...f.base,
      observeChecks: async (sha) => ({
        status: "waiting",
        expectedHeadSha: sha,
        missingChecks: [],
        pendingChecks: ["Build"],
        diagnostic: "Build queued",
      }),
    });
    expect(result.status).toBe("waiting");
    expect(f.base.repairPrimarySession).not.toHaveBeenCalled();
  });

  it("repairs a failed current head, verifies and republishes before accepting green checks", async () => {
    const f = fixture();
    const next = "b".repeat(40);
    const result = await runTaskSessionCiRepairs({
      ...f.base,
      observeChecks: async (sha) =>
        f.evaluation(sha, sha === f.sha ? "failed" : "passed"),
      publishSamePullRequest: async () => next,
    });
    expect(result).toMatchObject({
      status: "passed",
      attempts: 1,
      headSha: next,
    });
    expect(f.base.repairPrimarySession).toHaveBeenCalledWith(
      [],
      1,
      "session",
      expect.stringContaining(":ci:"),
    );
    expect(f.base.rerunLocalGatesAndReview).toHaveBeenCalledOnce();
    expect(f.store.read("card")?.pullRequest?.headSha).toBe(next);
  });

  it("waits on uncertain stale-head evidence without remediation", async () => {
    const f = fixture();
    const result = await runTaskSessionCiRepairs({
      ...f.base,
      observeChecks: async () => ({
        status: "uncertain",
        expectedHeadSha: f.sha,
        observedHeadSha: "c".repeat(40),
        expectedCheckNames: ["Build"],
        diagnostic: "Stale CI response",
      }),
    });
    expect(result.status).toBe("waiting");
    expect(f.base.repairPrimarySession).not.toHaveBeenCalled();
  });

  it("preserves the PR and escalates after two failed repair rounds", async () => {
    const f = fixture();
    const heads = ["b".repeat(40), "c".repeat(40)];
    const publishSamePullRequest = vi.fn(async () => heads.shift()!);
    const result = await runTaskSessionCiRepairs({
      ...f.base,
      observeChecks: async (sha) => f.evaluation(sha, "failed"),
      publishSamePullRequest,
    });
    expect(result.status).toBe("exhausted");
    expect(f.base.repairPrimarySession).toHaveBeenCalledTimes(2);
    expect(publishSamePullRequest).toHaveBeenCalledTimes(2);
    expect(f.store.read("card")?.phase).toBe("human-feedback");
    expect(f.store.read("card")?.pullRequest?.headSha).toBe("c".repeat(40));
  });

  it("pins a configured episode budget before dispatch and retains it across restart, SHA changes and configuration changes", async () => {
    const f = fixture();
    const heads = ["b".repeat(40), "c".repeat(40), "d".repeat(40)];
    const repair = vi.fn(async () => {
      const record = f.store.read("card")!;
      expect(record.ciRepair).toMatchObject({
        maxAttempts: 3,
        initiatingEventId: "operation:initial-publication",
      });
      expect(record.retryCounters.ci).toBe(repair.mock.calls.length);
    });
    const first = await runTaskSessionCiRepairs({
      ...f.base,
      maxAttempts: 3,
      repairPrimarySession: repair,
      publishSamePullRequest: async () => heads.shift()!,
      observeChecks: async (sha) =>
        sha === f.sha
          ? f.evaluation(sha, "failed")
          : {
              status: "waiting",
              expectedHeadSha: sha,
              missingChecks: ["Build"],
              pendingChecks: [],
              diagnostic: "not registered",
            },
    });
    expect(first.status).toBe("waiting");
    const result = await runTaskSessionCiRepairs({
      ...f.base,
      store: new TaskExecutionStore(path.join(root, "state"), {
        id: "project",
        repository: {
          path: path.join(root, "repo"),
          worktreeRoot: path.join(root, "worktrees"),
        },
      } as ProjectConfig),
      headSha: "b".repeat(40),
      maxAttempts: 10,
      repairPrimarySession: repair,
      publishSamePullRequest: async () => heads.shift()!,
      observeChecks: async (sha) => f.evaluation(sha, "failed"),
    });
    expect(result).toMatchObject({ status: "exhausted", attempts: 3 });
    expect(repair).toHaveBeenCalledTimes(3);
  });

  it("supports disabling CI corrections without disabling observation", async () => {
    const f = fixture();
    const result = await runTaskSessionCiRepairs({
      ...f.base,
      maxAttempts: 0,
      observeChecks: async (sha) => f.evaluation(sha, "failed"),
    });
    expect(result).toMatchObject({ status: "exhausted", attempts: 0 });
    expect(f.base.repairPrimarySession).not.toHaveBeenCalled();
    expect(f.store.read("card")?.phase).toBe("human-feedback");
  });
});
