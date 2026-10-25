import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import type { TaskExecutionRecord } from "../src/task-session/task-execution-record.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { runTaskSessionReviewWithRepairs } from "../src/task-session/run-task-session-review-repairs.js";

let root: string;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "review-repairs-"));
  const project = {
    id: "project",
    repository: {
      path: path.join(root, "repo"),
      worktreeRoot: path.join(root, "worktrees"),
    },
  } as ProjectConfig;
  fs.mkdirSync(project.repository.path, { recursive: true });
  const store = new TaskExecutionStore(path.join(root, "state"), project);
  const record: TaskExecutionRecord = {
    version: 1,
    projectId: "project",
    cardId: "card",
    phase: "review",
    primarySessionId: "primary-session",
    sessionCreationStatus: "bound",
    expectedBranch: "agent/card",
    operationKey: "operation",
    revision: 1,
    retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
    createdAt: "2026-10-24T09:00:00.000Z",
    updatedAt: "2026-10-24T09:00:00.000Z",
  };
  store.create(record);
  const identity = `sha256:${"a".repeat(64)}`;
  const makeReview = (verdict: "pass" | "fail") => ({
    version: 1 as const,
    projectId: "project",
    cardId: "card",
    verdict,
    requirementAssessments: [
      {
        requirementId: "REQ-1",
        status:
          verdict === "pass"
            ? ("satisfied" as const)
            : ("unsatisfied" as const),
        details: "finding",
        evidence: verdict === "pass" ? ["src/fix.ts"] : [],
      },
    ],
    blockingFindings:
      verdict === "pass"
        ? []
        : [
            {
              kind: "incomplete" as const,
              summary: "Missing",
              detail: "Fix requirement",
            },
          ],
    reviewedContentIdentity: identity,
  });
  const run = (verdicts: ("pass" | "fail")[], maxAttempts = 2) => {
    let index = 0;
    const reviewRun = vi.fn(async () => ({
      review: makeReview(verdicts[index++] ?? "fail"),
      contentIdentity: identity,
    }));
    const repair = vi.fn(async () => undefined);
    const rerunQuality = vi.fn(async () => undefined);
    return {
      repair,
      rerunQuality,
      reviewRun,
      run: () =>
        runTaskSessionReviewWithRepairs({
          store,
          maxAttempts,
          projectId: "project",
          cardId: "card",
          operationKey: "operation",
          expectedPrimarySessionId: "primary-session",
          runReview: reviewRun,
          repair: async () => repair(),
          rerunQuality,
          getCurrentContentIdentity: async () => identity,
        }),
    };
  };
  return { store, identity, run, makeReview };
}

describe("runTaskSessionReviewWithRepairs", () => {
  it("requires the latest independent review to pass after repair and quality rerun", async () => {
    const f = fixture();
    const op = f.run(["fail", "pass"]);
    const result = await op.run();
    expect(result.review.verdict).toBe("pass");
    expect(result.attempts).toBe(1);
    expect(op.repair).toHaveBeenCalledOnce();
    expect(op.rerunQuality).toHaveBeenCalledOnce();
    expect(result.record.reviewRepair?.status).toBe("passed");
  });

  it.each([0, 1, 2])(
    "honors maxPasses=%i and returns the final failed review for Human Review publication",
    async (maxPasses) => {
      const f = fixture();
      const op = f.run(["fail", "fail", "fail"], maxPasses);
      const result = await op.run();
      expect(result.review.verdict).toBe("fail");
      expect(result.attempts).toBe(maxPasses);
      expect(op.repair).toHaveBeenCalledTimes(maxPasses);
      expect(op.rerunQuality).toHaveBeenCalledTimes(maxPasses);
      expect(op.reviewRun).toHaveBeenCalledTimes(maxPasses + 1);
      expect(f.store.read("card")?.reviewRepair).toMatchObject({
        status: "exhausted",
        maxAttempts: maxPasses,
        finalReview: { verdict: "fail" },
      });
      const resumed = await op.run();
      expect(resumed.review.verdict).toBe("fail");
      expect(resumed.attempts).toBe(maxPasses);
      expect(op.reviewRun).toHaveBeenCalledTimes(maxPasses + 1);
      expect(op.repair).toHaveBeenCalledTimes(maxPasses);
    },
  );

  it("recovers a legacy exhausted record with exactly one persisted read-only review", async () => {
    const f = fixture();
    const existing = f.store.read("card")!;
    f.store.compareAndSwap("card", existing.revision, {
      ...existing,
      revision: existing.revision + 1,
      retryCounters: { ...existing.retryCounters, review: 2 },
      reviewRepair: { cycleId: "operation", status: "exhausted" },
      updatedAt: new Date().toISOString(),
    });
    const op = f.run(["fail"], 1);
    expect((await op.run()).review.verdict).toBe("fail");
    expect((await op.run()).review.verdict).toBe("fail");
    expect(op.reviewRun).toHaveBeenCalledOnce();
    expect(op.repair).not.toHaveBeenCalled();
    expect(f.store.read("card")?.reviewRepair?.maxAttempts).toBe(2);
  });

  it("rejects stale review evidence before remediation", async () => {
    const f = fixture();
    await expect(
      runTaskSessionReviewWithRepairs({
        store: f.store,
        maxAttempts: 2,
        projectId: "project",
        cardId: "card",
        operationKey: "operation",
        expectedPrimarySessionId: "primary-session",
        runReview: async () => ({
          review: f.makeReview("fail"),
          contentIdentity: f.identity,
        }),
        repair: async () => undefined,
        rerunQuality: async () => undefined,
        getCurrentContentIdentity: async () => `sha256:${"b".repeat(64)}`,
      }),
    ).rejects.toThrow("stale source snapshot");
  });
});
