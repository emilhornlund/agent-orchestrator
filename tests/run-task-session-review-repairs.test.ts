import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import type { TaskExecutionRecord } from "../src/task-session/task-execution-record.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import {
  runTaskSessionReviewWithRepairs,
  TaskSessionReviewRepairExhaustedError,
} from "../src/task-session/run-task-session-review-repairs.js";

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
        evidence: [],
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
  const run = (verdicts: ("pass" | "fail")[]) => {
    let index = 0;
    const repair = vi.fn(async () => undefined);
    const rerunQuality = vi.fn(async () => undefined);
    return {
      repair,
      rerunQuality,
      run: () =>
        runTaskSessionReviewWithRepairs({
          store,
          projectId: "project",
          cardId: "card",
          operationKey: "operation",
          expectedPrimarySessionId: "primary-session",
          runReview: async () => ({
            review: makeReview(verdicts[index++] ?? "fail"),
            contentIdentity: identity,
          }),
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

  it("runs the final review after the second repair and blocks on exhaustion", async () => {
    const f = fixture();
    const op = f.run(["fail", "fail", "fail"]);
    await expect(op.run()).rejects.toBeInstanceOf(
      TaskSessionReviewRepairExhaustedError,
    );
    expect(op.repair).toHaveBeenCalledTimes(2);
    expect(op.rerunQuality).toHaveBeenCalledTimes(2);
    expect(f.store.read("card")?.reviewRepair?.status).toBe("exhausted");
  });

  it("rejects stale review evidence before remediation", async () => {
    const f = fixture();
    await expect(
      runTaskSessionReviewWithRepairs({
        store: f.store,
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
