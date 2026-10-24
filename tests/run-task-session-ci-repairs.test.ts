import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import type { CiCheckEvaluation } from "../src/github/evaluate-ci-checks.js";
import { runTaskSessionCiRepairs } from "../src/task-session/run-task-session-ci-repairs.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";

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
    expect(f.base.repairPrimarySession).toHaveBeenCalledWith([], 1, "session");
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
    expect(f.store.read("card")?.phase).toBe("attention-required");
    expect(f.store.read("card")?.pullRequest?.headSha).toBe("c".repeat(40));
  });
});
