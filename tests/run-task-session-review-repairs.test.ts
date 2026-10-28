import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import type { TaskExecutionRecord } from "../src/task-session/task-execution-record.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { Logger } from "../src/logging/logger.js";
import {
  runTaskSessionReviewWithRepairs,
  TaskSessionReviewRepairError,
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
    const reviewRun = vi.fn(
      async (
        previousFindings: readonly NonNullable<
          NonNullable<TaskExecutionRecord["reviewRepair"]>["findings"]
        >[number][] = [],
      ) => {
        const verdict = verdicts[index++] ?? "fail";
        const review = makeReview(verdict);
        return {
          review: {
            ...review,
            blockingFindings:
              verdict === "fail" && previousFindings.length > 0
                ? previousFindings.map(
                    ({ id, kind, summary, detail, location }) => ({
                      id,
                      kind,
                      summary,
                      detail,
                      ...(location === undefined ? {} : { location }),
                    }),
                  )
                : review.blockingFindings,
            previousFindingAssessments: previousFindings.map(({ id }) => ({
              findingId: id,
              status:
                verdict === "pass"
                  ? ("resolved" as const)
                  : ("unresolved" as const),
            })),
          },
          contentIdentity: identity,
        };
      },
    );
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
  it("logs bounded structured finding transitions for successful review cycles", async () => {
    const f = fixture();
    const events: string[] = [];
    vi.spyOn(Logger.prototype, "event").mockImplementation((message) => {
      events.push(message);
    });
    const op = f.run(["fail", "pass"]);
    await op.run();

    const round = events
      .filter((message) => message.startsWith("review-cycle "))
      .map(
        (message) =>
          JSON.parse(message.slice("review-cycle ".length)) as Record<
            string,
            unknown
          >,
      )
      .find((event) => event.event === "review-round");
    expect(round).toMatchObject({
      reviewPass: 1,
      remediationAttempt: 0,
      verdict: "fail",
      newlyDiscoveredBlockingFindingIds: {
        ids: [expect.stringMatching(/^finding-/)],
        omitted: 0,
      },
    });
    expect(
      events.some((message) => message.includes('"event":"cycle-passed"')),
    ).toBe(true);
    expect(events.join(" ")).not.toContain("Fix requirement");
  });

  it("logs exhausted findings and restores useful diagnostics from persisted state", async () => {
    const f = fixture();
    const events: string[] = [];
    vi.spyOn(Logger.prototype, "event").mockImplementation((message) => {
      events.push(message);
    });
    const op = f.run(["fail"], 0);
    const result = await op.run();
    const findingId = result.record.reviewRepair?.findings?.[0]?.id;
    expect(
      events.some(
        (message) =>
          message.includes('"event":"cycle-exhausted"') &&
          message.includes(findingId ?? "not-found"),
      ),
    ).toBe(true);
    await op.run();
    expect(
      events.some((message) => message.includes('"event":"cycle-recovered"')),
    ).toBe(true);
  });

  it("categorizes remediation execution and validation failures distinctly", async () => {
    const f = fixture();
    const events: string[] = [];
    vi.spyOn(Logger.prototype, "event").mockImplementation((message) => {
      events.push(message);
    });
    const options = {
      store: f.store,
      maxAttempts: 1,
      projectId: "project",
      cardId: "card",
      operationKey: "operation",
      expectedPrimarySessionId: "primary-session",
      runReview: async () => ({
        review: f.makeReview("fail"),
        contentIdentity: f.identity,
      }),
      getCurrentContentIdentity: async () => f.identity,
    };
    await expect(
      runTaskSessionReviewWithRepairs({
        ...options,
        repair: async () => {
          throw new Error("execution details must not be logged");
        },
        rerunQuality: async () => undefined,
      }),
    ).rejects.toThrow("Review repair execution failed");
    expect(
      events.some((message) =>
        message.includes('"category":"remediation-execution"'),
      ),
    ).toBe(true);
    expect(events.join(" ")).not.toContain(
      "execution details must not be logged",
    );

    fs.rmSync(root, { recursive: true, force: true });
    const validationFixture = fixture();
    await expect(
      runTaskSessionReviewWithRepairs({
        ...options,
        store: validationFixture.store,
        runReview: async () => ({
          review: validationFixture.makeReview("fail"),
          contentIdentity: validationFixture.identity,
        }),
        getCurrentContentIdentity: async () => validationFixture.identity,
        repair: async () => undefined,
        rerunQuality: async () => {
          throw new Error("quality failed");
        },
      }),
    ).rejects.toThrow("validation or coverage failed");
    expect(
      events.some((message) => message.includes('"category":"validation"')),
    ).toBe(true);
  });

  it("logs review execution and result-validation failures as review failures", async () => {
    const f = fixture();
    const events: string[] = [];
    vi.spyOn(Logger.prototype, "event").mockImplementation((message) => {
      events.push(message);
    });

    await expect(
      runTaskSessionReviewWithRepairs({
        store: f.store,
        maxAttempts: 1,
        projectId: "project",
        cardId: "card",
        operationKey: "operation",
        expectedPrimarySessionId: "primary-session",
        runReview: async () => {
          throw new Error("private session output");
        },
        repair: async () => undefined,
        rerunQuality: async () => undefined,
        getCurrentContentIdentity: async () => f.identity,
      }),
    ).rejects.toThrow("private session output");

    expect(
      events.some((message) =>
        message.includes(
          '"event":"cycle-failed","category":"review","stage":"execution","reviewPass":1,"remediationAttempt":0',
        ),
      ),
    ).toBe(true);
    expect(events.join(" ")).not.toContain("private session output");

    const current = f.store.read("card")!;
    f.store.compareAndSwap("card", current.revision, {
      ...current,
      revision: current.revision + 1,
      reviewRepair: {
        cycleId: "operation",
        status: "active",
        maxAttempts: 1,
        findings: [
          {
            id: "prior-finding",
            kind: "incomplete",
            summary: "Prior issue",
            detail: "Must be explicitly assessed",
            sourceContentIdentity: f.identity,
            sourceIdentities: [f.identity],
            status: "unresolved",
          },
        ],
      },
      updatedAt: new Date().toISOString(),
    });
    await expect(
      runTaskSessionReviewWithRepairs({
        store: f.store,
        maxAttempts: 1,
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
        getCurrentContentIdentity: async () => f.identity,
      }),
    ).rejects.toThrow("Review omitted prior finding");
    expect(
      events.some((message) =>
        message.includes(
          '"event":"cycle-failed","category":"review","stage":"result-validation"',
        ),
      ),
    ).toBe(true);
  });

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

  it("keeps earlier findings traceable while recording newly discovered defects", async () => {
    const f = fixture();
    let pass = 0;
    const result = await runTaskSessionReviewWithRepairs({
      store: f.store,
      maxAttempts: 1,
      projectId: "project",
      cardId: "card",
      operationKey: "operation",
      expectedPrimarySessionId: "primary-session",
      runReview: async (previousFindings) => {
        const review = f.makeReview("fail");
        const finding =
          pass++ === 0
            ? {
                kind: "incomplete" as const,
                summary: "First defect",
                detail: "First defect remains.",
              }
            : {
                kind: "defect" as const,
                summary: "Regression",
                detail: "A new regression appeared.",
              };
        return {
          review: {
            ...review,
            blockingFindings: [
              ...previousFindings.map(
                ({ id, kind, summary, detail, location }) => ({
                  id,
                  kind,
                  summary,
                  detail,
                  ...(location === undefined ? {} : { location }),
                }),
              ),
              finding,
            ],
            previousFindingAssessments: previousFindings.map(({ id }) => ({
              findingId: id,
              status: "unresolved" as const,
            })),
          },
          contentIdentity: f.identity,
        };
      },
      repair: async () => undefined,
      rerunQuality: async () => undefined,
      getCurrentContentIdentity: async () => f.identity,
    });

    expect(result.record.reviewRepair?.findings).toHaveLength(2);
    expect(
      result.record.reviewRepair?.findings?.map(({ summary }) => summary),
    ).toEqual(["First defect", "Regression"]);
    expect(result.review.blockingFindings[0]?.id).toMatch(/^finding-/);
    expect(result.record.reviewRepair?.findings?.[0]?.sourceIdentities).toEqual(
      [f.identity],
    );
  });

  it("records a resolved prior finding as blocking only with new source evidence", async () => {
    const f = fixture();
    const priorIdentity = `sha256:${"b".repeat(64)}`;
    const existing = f.store.read("card")!;
    f.store.compareAndSwap("card", existing.revision, {
      ...existing,
      revision: existing.revision + 1,
      reviewRepair: {
        cycleId: "operation",
        status: "active",
        maxAttempts: 0,
        findings: [
          {
            id: "prior-finding",
            kind: "defect",
            summary: "Prior defect",
            detail: "Previously resolved defect",
            sourceContentIdentity: priorIdentity,
            sourceIdentities: [priorIdentity],
            status: "resolved",
          },
        ],
      },
      updatedAt: new Date().toISOString(),
    });

    const result = await runTaskSessionReviewWithRepairs({
      store: f.store,
      maxAttempts: 0,
      projectId: "project",
      cardId: "card",
      operationKey: "operation",
      expectedPrimarySessionId: "primary-session",
      runReview: async (previousFindings) => {
        expect(previousFindings[0]?.sourceIdentities).toEqual([priorIdentity]);
        return {
          review: {
            ...f.makeReview("fail"),
            blockingFindings: [
              {
                id: "prior-finding",
                sourceContentIdentity: f.identity,
                kind: "defect",
                summary: "Prior defect has returned",
                detail:
                  "Evidence: src/feature.ts:12 reproduces the prior defect in the current source. Expected behavior: preserve the corrected handling.",
                location: { filePath: "src/feature.ts", line: 12 },
              },
            ],
            previousFindingAssessments: previousFindings.map(({ id }) => ({
              findingId: id,
              status: "resolved" as const,
            })),
          },
          contentIdentity: f.identity,
        };
      },
      repair: async () => undefined,
      rerunQuality: async () => undefined,
      getCurrentContentIdentity: async () => f.identity,
    });

    expect(result.review.blockingFindings[0]).toMatchObject({
      id: "prior-finding",
      sourceContentIdentity: f.identity,
    });
    expect(result.record.reviewRepair?.findings?.[0]).toMatchObject({
      id: "prior-finding",
      status: "unresolved",
      sourceIdentities: [priorIdentity, f.identity],
    });
  });

  it("rejects reopening a resolved finding at any previously reviewed identity", async () => {
    const f = fixture();
    const priorIdentity = `sha256:${"b".repeat(64)}`;
    const existing = f.store.read("card")!;
    f.store.compareAndSwap("card", existing.revision, {
      ...existing,
      revision: existing.revision + 1,
      reviewRepair: {
        cycleId: "operation",
        status: "active",
        maxAttempts: 1,
        findings: [
          {
            id: "prior-finding",
            kind: "defect",
            summary: "Prior defect",
            detail: "Previously resolved defect",
            sourceContentIdentity: priorIdentity,
            sourceIdentities: [priorIdentity, f.identity],
            status: "resolved",
          },
        ],
      },
      updatedAt: new Date().toISOString(),
    });

    await expect(
      runTaskSessionReviewWithRepairs({
        store: f.store,
        maxAttempts: 1,
        projectId: "project",
        cardId: "card",
        operationKey: "operation",
        expectedPrimarySessionId: "primary-session",
        runReview: async (previousFindings) => ({
          review: {
            ...f.makeReview("fail"),
            blockingFindings: [
              {
                id: "prior-finding",
                sourceContentIdentity: f.identity,
                kind: "defect",
                summary: "Prior defect has returned",
                detail:
                  "Evidence: src/feature.ts:12 reproduces the prior defect in the current source.",
                location: { filePath: "src/feature.ts", line: 12 },
              },
            ],
            previousFindingAssessments: previousFindings.map(({ id }) => ({
              findingId: id,
              status: "resolved" as const,
            })),
          },
          contentIdentity: f.identity,
        }),
        repair: async () => undefined,
        rerunQuality: async () => undefined,
        getCurrentContentIdentity: async () => f.identity,
      }),
    ).rejects.toThrow("Review lists resolved prior finding as blocking");
  });

  it("cannot complete a cycle while a prior finding is classified unresolved", async () => {
    const f = fixture();
    let pass = 0;
    await expect(
      runTaskSessionReviewWithRepairs({
        store: f.store,
        maxAttempts: 1,
        projectId: "project",
        cardId: "card",
        operationKey: "operation",
        expectedPrimarySessionId: "primary-session",
        runReview: async (previousFindings) => {
          const verdict = pass++ === 0 ? "fail" : "pass";
          return {
            review: {
              ...f.makeReview(verdict),
              previousFindingAssessments: previousFindings.map(({ id }) => ({
                findingId: id,
                status: "unresolved" as const,
              })),
            },
            contentIdentity: f.identity,
          };
        },
        repair: async () => undefined,
        rerunQuality: async () => undefined,
        getCurrentContentIdentity: async () => f.identity,
      }),
    ).rejects.toThrow("Unresolved prior finding must remain blocking");
    expect(f.store.read("card")?.reviewRepair?.status).toBe("active");
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
        findings: [
          { id: expect.stringMatching(/^finding-/), status: "unresolved" },
        ],
      });
      const persistedFindingId =
        f.store.read("card")?.reviewRepair?.findings?.[0]?.id;
      const restored = new TaskExecutionStore(path.join(root, "state"), {
        id: "project",
        repository: {
          path: path.join(root, "repo"),
          worktreeRoot: path.join(root, "worktrees"),
        },
      } as ProjectConfig);
      expect(restored.read("card")?.reviewRepair?.findings?.[0]?.id).toBe(
        persistedFindingId,
      );
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

  it.each([
    ["unchanged", false],
    ["changed", true],
  ] as const)(
    "captures %s source identity after a failed repair without publishing",
    async (_label, changed) => {
      const f = fixture();
      const changedIdentity = `sha256:${"b".repeat(64)}`;
      let currentIdentity = f.identity;
      const repair = vi.fn(async () => {
        if (changed) currentIdentity = changedIdentity;
        throw new Error("OpenCode remediation interrupted");
      });
      let failure: unknown;
      try {
        await runTaskSessionReviewWithRepairs({
          store: f.store,
          maxAttempts: 1,
          projectId: "project",
          cardId: "card",
          operationKey: "operation",
          expectedPrimarySessionId: "primary-session",
          runReview: async () => ({
            review: f.makeReview("fail"),
            contentIdentity: f.identity,
          }),
          repair,
          rerunQuality: async () => undefined,
          getCurrentContentIdentity: async () => currentIdentity,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(TaskSessionReviewRepairError);
      const diagnostic = (failure as TaskSessionReviewRepairError)
        .sourceIdentity;
      expect(diagnostic).toEqual({
        before: f.identity,
        after: currentIdentity,
        unchanged: !changed,
      });
      expect(repair).toHaveBeenCalledOnce();
      expect(f.store.read("card")?.reviewRepair?.status).toBe("active");
      expect(f.store.read("card")?.retryCounters.review).toBe(1);
      expect(f.store.read("card")?.reviewRemediationFailure).toMatchObject({
        cycleId: "operation",
        attempt: 1,
        before: f.identity,
        after: currentIdentity,
        unchanged: !changed,
      });
      const restored = new TaskExecutionStore(path.join(root, "state"), {
        id: "project",
        repository: {
          path: path.join(root, "repo"),
          worktreeRoot: path.join(root, "worktrees"),
        },
      } as ProjectConfig);
      expect(restored.read("card")?.reviewRemediationFailure?.unchanged).toBe(
        !changed,
      );
    },
  );

  it("fails closed when source identity cannot be rechecked after repair failure", async () => {
    const f = fixture();
    let checks = 0;
    await expect(
      runTaskSessionReviewWithRepairs({
        store: f.store,
        maxAttempts: 1,
        projectId: "project",
        cardId: "card",
        operationKey: "operation",
        expectedPrimarySessionId: "primary-session",
        runReview: async () => ({
          review: f.makeReview("fail"),
          contentIdentity: f.identity,
        }),
        repair: async () => {
          throw new Error("remediation failed");
        },
        rerunQuality: async () => undefined,
        getCurrentContentIdentity: async () => {
          if (++checks > 1) throw new Error("unreadable worktree");
          return f.identity;
        },
      }),
    ).rejects.toMatchObject({
      sourceIdentity: { before: f.identity, after: null, unchanged: false },
    });
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
