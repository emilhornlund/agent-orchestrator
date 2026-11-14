import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import type { TaskExecutionRecord } from "../src/task-session/task-execution-record.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { Logger } from "../src/logging/logger.js";
import { withProcessCancellationSignal } from "../src/process/process-runtime.js";
import { OpenCodeRunAbortedError } from "../src/opencode/opencode-client.js";
import {
  hasUndisposedReviewConcerns,
  parsePrimaryReviewDispositionReport,
  type ImplementationReviewResult,
} from "../src/task-session/implementation-review-result.js";
import { REVIEW_REPAIR_FINISHED_EARLY_MARKER } from "../src/opencode/build-task-session-review-repair-prompt.js";
import {
  carryReviewRepairIntoCiCorrection,
  createReviewRoundRunner,
  parsePrimaryReviewRepairOutcome,
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
  let currentIdentity = `sha256:${"a".repeat(64)}`;
  let identityGeneration = 1;
  const advanceIdentity = () => {
    identityGeneration += 1;
    currentIdentity = `sha256:${String.fromCharCode(96 + identityGeneration).repeat(64)}`;
  };
  const makeReview = (verdict: "pass" | "fail") => ({
    version: 1 as const,
    projectId: "project",
    cardId: "card",
    verdict,
    requirementAssessments: [
      {
        requirementId: "REQ-1",
        status: verdict === "pass" ? ("satisfied" as const) : ("unsatisfied" as const),
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
    reviewedContentIdentity: currentIdentity,
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
                ? previousFindings.map(({ id, kind, summary, detail, location }) => ({
                    id,
                    kind,
                    summary,
                    detail,
                    ...(location === undefined ? {} : { location }),
                  }))
                : review.blockingFindings,
            previousFindingAssessments: previousFindings.map(({ id }) => ({
              findingId: id,
              status: verdict === "pass" ? ("resolved" as const) : ("unresolved" as const),
            })),
          },
          contentIdentity: currentIdentity,
        };
      },
    );
    const repair = vi.fn(async () => {
      advanceIdentity();
    });
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
          getCurrentContentIdentity: async () => currentIdentity,
        }),
    };
  };
  return {
    store,
    get identity() {
      return currentIdentity;
    },
    run,
    makeReview,
    advanceIdentity,
    project,
  };
}

describe("runTaskSessionReviewWithRepairs", () => {
  it.each([true, false])(
    "distinguishes review shutdown cancellation from a concurrent real failure (cancelled=%s)",
    async (cancelled) => {
      const f = fixture();
      const cycle = f.run(["pass"]);
      const controller = new AbortController();
      const error = cancelled
        ? new OpenCodeRunAbortedError()
        : new Error("Independent review failure");
      cycle.reviewRun.mockImplementationOnce(async () => {
        controller.abort();
        throw error;
      });
      const events = vi.spyOn(Logger.prototype, "event").mockImplementation(() => undefined);
      try {
        await expect(
          withProcessCancellationSignal(controller.signal, () => cycle.run()),
        ).rejects.toBe(error);
        const output = events.mock.calls.map(([message]) => message).join("\n");
        expect(output).toContain(`"event":"${cancelled ? "cycle-cancelled" : "cycle-failed"}"`);
        expect(output).not.toContain(`"event":"${cancelled ? "cycle-failed" : "cycle-cancelled"}"`);
        expect(f.store.read("card")?.retryCounters.review).toBe(0);
        expect(f.store.read("card")?.phase).toBe("review");
      } finally {
        events.mockRestore();
      }
    },
  );
  it("consumes a cached first review once and requests current source for later rounds", async () => {
    const f = fixture();
    const identities = [
      `sha256:${"a".repeat(64)}`,
      `sha256:${"b".repeat(64)}`,
      `sha256:${"c".repeat(64)}`,
    ];
    let current = 0;
    const readOnlyReviews = vi.fn(async () => {
      current += 1;
      const identity = identities[current]!;
      return {
        review: {
          ...f.makeReview("fail"),
          reviewedContentIdentity: identity,
        },
        contentIdentity: identity,
      };
    });
    const runner = createReviewRoundRunner(
      {
        review: {
          ...f.makeReview("fail"),
          reviewedContentIdentity: identities[0]!,
        },
        contentIdentity: identities[0]!,
      },
      async () => readOnlyReviews(),
    );

    const first = await runner([]);
    const afterCorrectionOne = await runner([]);
    const afterCorrectionTwo = await runner([]);

    expect(first.contentIdentity).toBe(identities[0]);
    expect(afterCorrectionOne.contentIdentity).toBe(identities[1]);
    expect(afterCorrectionTwo.contentIdentity).toBe(identities[2]);
    expect(afterCorrectionTwo.review.reviewedContentIdentity).toBe(identities[2]);
    expect(readOnlyReviews).toHaveBeenCalledTimes(2);
  });

  it("persists primary materiality dispositions tied to the reviewed content", async () => {
    const f = fixture();
    const firstReviewedIdentity = f.identity;
    let reviews = 0;
    const result = await runTaskSessionReviewWithRepairs({
      store: f.store,
      projectId: "project",
      cardId: "card",
      operationKey: "operation",
      expectedPrimarySessionId: "primary-session",
      maxAttempts: 1,
      runReview: async (previousFindings) => {
        reviews += 1;
        if (reviews === 1)
          return {
            review: f.makeReview("fail"),
            contentIdentity: f.identity,
          };
        const pass = f.makeReview("pass");
        return {
          review: {
            ...pass,
            previousFindingAssessments: previousFindings.map(({ id }) => ({
              findingId: id,
              status: "resolved" as const,
            })),
          },
          contentIdentity: f.identity,
        };
      },
      repair: async (review) => {
        f.advanceIdentity();
        return {
          version: 1,
          findingDispositions: review.blockingFindings.map(({ id }) => ({
            findingId: id!,
            status: "dismissed" as const,
            rationale:
              "The task behavior is correct; this suggestion is an unrelated stylistic preference.",
          })),
          requirementDispositions: review.requirementAssessments
            .filter(({ status }) => status === "unsatisfied")
            .map(({ requirementId }) => ({
              requirementId,
              status: "dismissed" as const,
              rationale:
                "The requirement is implemented; the assessment interpreted its expected behavior too narrowly.",
            })),
        };
      },
      rerunQuality: async () => undefined,
      getCurrentContentIdentity: async () => f.identity,
    });

    expect(result.review.verdict).toBe("pass");
    expect(result.record.reviewRepair?.findings?.[0]?.primaryDisposition).toEqual({
      reviewedContentIdentity: firstReviewedIdentity,
      status: "dismissed",
      rationale:
        "The task behavior is correct; this suggestion is an unrelated stylistic preference.",
    });
    expect(result.record.reviewRepair?.requirementDispositions).toEqual([
      {
        requirementId: "REQ-1",
        reviewedContentIdentity: firstReviewedIdentity,
        status: "dismissed",
        rationale:
          "The requirement is implemented; the assessment interpreted its expected behavior too narrowly.",
      },
    ]);
    const restartedStore = new TaskExecutionStore(path.join(root, "state"), f.project);
    const recovered = restartedStore.read("card")!;
    const requirementOnlyNegativeReview = {
      ...f.makeReview("fail"),
      reviewedContentIdentity: firstReviewedIdentity,
      blockingFindings: [],
      requirementAssessments: [
        {
          requirementId: "REQ-1",
          status: "unsatisfied" as const,
          details: "The reviewer assessment remains negative.",
          evidence: [],
        },
      ],
    };
    expect(
      hasUndisposedReviewConcerns(
        requirementOnlyNegativeReview,
        recovered.reviewRepair?.findings ?? [],
        recovered.reviewRepair?.requirementDispositions ?? [],
      ),
    ).toBe(false);
  });

  it("treats an oversized primary disposition as absent and clears the completed reservation", async () => {
    const f = fixture();
    let reviews = 0;
    const result = await runTaskSessionReviewWithRepairs({
      store: f.store,
      projectId: "project",
      cardId: "card",
      operationKey: "operation",
      expectedPrimarySessionId: "primary-session",
      maxAttempts: 1,
      runReview: async (previousFindings) => {
        reviews += 1;
        if (reviews === 1)
          return {
            review: f.makeReview("fail"),
            contentIdentity: f.identity,
          };
        const fail = f.makeReview("fail");
        return {
          review: {
            ...fail,
            blockingFindings: previousFindings.map(({ id, kind, summary, detail, location }) => ({
              id,
              kind,
              summary,
              detail,
              ...(location === undefined ? {} : { location }),
            })),
            previousFindingAssessments: previousFindings.map(({ id }) => ({
              findingId: id,
              status: "unresolved" as const,
            })),
          },
          contentIdentity: f.identity,
        };
      },
      repair: async (review) => {
        f.advanceIdentity();
        return parsePrimaryReviewDispositionReport(
          JSON.stringify({
            version: 1,
            findingDispositions: review.blockingFindings.map(({ id }, index) => ({
              findingId: id,
              status: "addressed",
              rationale: index === 0 ? "r".repeat(4_001) : "Handled the finding.",
            })),
            requirementDispositions: review.requirementAssessments
              .filter(({ status }) => status === "unsatisfied")
              .map(({ requirementId }) => ({
                requirementId,
                status: "addressed",
                rationale: "Implemented the requested requirement.",
              })),
          }),
          review.blockingFindings.flatMap(({ id }) => (id === undefined ? [] : [id])),
          review.requirementAssessments
            .filter(({ status }) => status === "unsatisfied")
            .map(({ requirementId }) => requirementId),
        );
      },
      rerunQuality: async () => undefined,
      getCurrentContentIdentity: async () => f.identity,
    });

    expect(result.review.verdict).toBe("fail");
    expect(result.record.reviewRepair?.status).toBe("exhausted");
    expect(result.record.reviewRepair?.activePrimaryOperation).toBeUndefined();
    expect(result.record.reviewRemediationFailure).toBeUndefined();
    expect(result.record.reviewRepair?.findings?.[0]?.primaryDisposition).toBeUndefined();
    expect(result.record.reviewRepair?.findings?.[0]?.status).toBe("unresolved");
    expect(result.record.reviewRepair?.requirementDispositions).toEqual([]);
  });

  it("resumes a reserved last-pass repair before review and reuses exact ID and prompt", async () => {
    const f = fixture();
    const prompt = "persisted exact repair prompt";
    const operationId = "operation:review:operation:pass:2";
    const promptArtifact = f.store.writePrimaryResultArtifact(`${operationId}:prompt`, {
      prompt,
      review: f.makeReview("fail"),
    });
    const record = f.store.read("card")!;
    f.store.compareAndSwap("card", record.revision, {
      ...record,
      retryCounters: { ...record.retryCounters, review: 2 },
      reviewRepair: {
        cycleId: "operation",
        status: "active",
        maxAttempts: 2,
        activePrimaryOperation: { operationId, pass: 2, promptArtifact },
      },
      revision: record.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    const order: string[] = [];
    const reviewRun = vi.fn(async () => {
      order.push("review");
      return { review: f.makeReview("pass"), contentIdentity: f.identity };
    });
    const repair = vi.fn(
      async (review: unknown, attempt: number, id: string, exactPrompt?: string) => {
        expect(review).toEqual(expect.objectContaining({ verdict: "fail" }));
        expect(attempt).toBe(2);
        expect(id).toBe(operationId);
        expect(exactPrompt).toBe(prompt);
        order.push("repair");
        f.advanceIdentity();
      },
    );
    const quality = vi.fn(async () => undefined);
    await runTaskSessionReviewWithRepairs({
      store: f.store,
      projectId: "project",
      cardId: "card",
      operationKey: "operation",
      expectedPrimarySessionId: "primary-session",
      maxAttempts: 2,
      runReview: reviewRun,
      buildRepairPrompt: () => "new prompt must not be used",
      repair: async (...args) => repair(...args),
      rerunQuality: quality,
      getCurrentContentIdentity: async () => f.identity,
    });
    expect(reviewRun).toHaveBeenCalledOnce();
    expect(order).toEqual(["repair", "review"]);
    expect(repair).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: "fail" }),
      2,
      operationId,
      prompt,
    );
    expect(quality).toHaveBeenCalledOnce();
    expect(f.store.read("card")?.reviewRepair?.activePrimaryOperation).toBeUndefined();
  });

  it("recovers a post-edit interruption from the same primary reservation before review", async () => {
    const f = fixture();
    const changedIdentity = `sha256:${"b".repeat(64)}`;
    const operationIds: string[] = [];
    let actualExecutions = 0;
    let cachedResult: "complete" | undefined;
    let currentIdentity = f.identity;
    const run = () =>
      runTaskSessionReviewWithRepairs({
        store: f.store,
        maxAttempts: 1,
        projectId: "project",
        cardId: "card",
        operationKey: "operation",
        expectedPrimarySessionId: "primary-session",
        runReview: async () => ({
          review: f.makeReview("fail"),
          contentIdentity: currentIdentity,
        }),
        buildRepairPrompt: () => "persisted review repair prompt",
        repair: async (_review, _pass, operationId, prompt) => {
          operationIds.push(operationId);
          if (cachedResult !== undefined) return;
          actualExecutions += 1;
          expect(prompt).toBe("persisted review repair prompt");
          currentIdentity = changedIdentity;
          cachedResult = "complete";
          throw new Error("interrupted after edits before result checkpoint");
        },
        rerunQuality: async () => undefined,
        getCurrentContentIdentity: async () => currentIdentity,
      });

    await expect(run()).rejects.toThrow("Review repair execution failed");
    const active = f.store.read("card")?.reviewRepair?.activePrimaryOperation;
    expect(active?.operationId).toBe("operation:review:operation:pass:1");
    expect(f.store.read("card")?.reviewRemediationFailure).toBeUndefined();

    const persisted = f.store.readPrimaryResultArtifact({
      reference: active!.promptArtifact!.reference as `sha256:${string}`,
      bytes: active!.promptArtifact!.bytes,
      ...(active!.promptArtifact!.path === undefined ? {} : { path: active!.promptArtifact!.path }),
    }) as { prompt: string };
    const resumedCalls: Array<{ operationId: string; prompt?: string }> = [];
    const result = await runTaskSessionReviewWithRepairs({
      store: f.store,
      maxAttempts: 1,
      projectId: "project",
      cardId: "card",
      operationKey: "operation",
      expectedPrimarySessionId: "primary-session",
      runReview: async (previousFindings) => ({
        review: {
          ...f.makeReview("pass"),
          reviewedContentIdentity: currentIdentity,
          previousFindingAssessments: previousFindings.map(({ id }) => ({
            findingId: id,
            status: "resolved" as const,
          })),
        },
        contentIdentity: currentIdentity,
      }),
      repair: async (_review, _pass, operationId, prompt) => {
        resumedCalls.push({
          operationId,
          ...(prompt === undefined ? {} : { prompt }),
        });
        // The primary-operation ledger has authoritative completion evidence;
        // recovery adopts its result instead of dispatching a second execution.
        if (cachedResult === undefined) actualExecutions += 1;
        cachedResult = "complete";
      },
      rerunQuality: async () => undefined,
      getCurrentContentIdentity: async () => currentIdentity,
    });

    expect(resumedCalls).toEqual([
      {
        operationId: "operation:review:operation:pass:1",
        prompt: persisted.prompt,
      },
    ]);
    expect(operationIds).toEqual(["operation:review:operation:pass:1"]);
    expect(actualExecutions).toBe(1);
    expect(result.review.verdict).toBe("pass");
  });

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
        (message) => JSON.parse(message.slice("review-cycle ".length)) as Record<string, unknown>,
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
    expect(events.some((message) => message.includes('"event":"cycle-passed"'))).toBe(true);
    expect(events.join(" ")).not.toContain("Fix requirement");
  });

  it.each(["skipped", "failed", "uncertain"] as const)(
    "reports recorded %s coverage without calling it passed",
    async (status) => {
      const f = fixture();
      const current = f.store.read("card")!;
      f.store.compareAndSwap("card", current.revision, {
        ...current,
        validationRepair: {
          cycleId: "operation",
          status: "passed",
          evidence: {
            command: "validate",
            status: "passed",
            startedAt: current.updatedAt,
            completedAt: current.updatedAt,
            exitCode: 0,
            diagnostic: "passed",
            contentIdentity: `sha256:${"a".repeat(64)}`,
          },
          coverageEvidence: {
            command: status === "skipped" ? "" : "coverage",
            status,
            startedAt: current.updatedAt,
            completedAt: current.updatedAt,
            exitCode: status === "failed" ? 1 : null,
            diagnostic: status,
            contentIdentity: `sha256:${"a".repeat(64)}`,
          },
        },
        revision: current.revision + 1,
        updatedAt: "2026-10-24T09:00:01.000Z",
      });
      const events: string[] = [];
      vi.spyOn(Logger.prototype, "event").mockImplementation((message) => {
        events.push(message);
      });
      await f.run(["pass"]).run();
      expect(events.some((message) => message.includes(`"coverage":"${status}"`))).toBe(true);
      expect(events.some((message) => message.includes('"coverage":"passed"'))).toBe(false);
    },
  );

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
    expect(events.some((message) => message.includes('"event":"cycle-recovered"'))).toBe(true);
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
    expect(events.some((message) => message.includes('"category":"remediation-execution"'))).toBe(
      true,
    );
    expect(events.join(" ")).not.toContain("execution details must not be logged");

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
        repair: async () => {
          validationFixture.advanceIdentity();
        },
        rerunQuality: async () => {
          throw new Error("quality failed");
        },
      }),
    ).rejects.toThrow("validation or coverage failed");
    expect(events.some((message) => message.includes('"category":"validation"'))).toBe(true);
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
        message.includes('"event":"cycle-failed","category":"review","stage":"result-validation"'),
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
              ...previousFindings.map(({ id, kind, summary, detail, location }) => ({
                id,
                kind,
                summary,
                detail,
                ...(location === undefined ? {} : { location }),
              })),
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
      repair: async () => {
        f.advanceIdentity();
      },
      rerunQuality: async () => undefined,
      getCurrentContentIdentity: async () => f.identity,
    });

    expect(result.record.reviewRepair?.findings).toHaveLength(2);
    expect(result.record.reviewRepair?.findings?.map(({ summary }) => summary)).toEqual([
      "First defect",
      "Regression",
    ]);
    expect(result.review.blockingFindings[0]?.id).toMatch(/^finding-/);
    expect(result.record.reviewRepair?.findings?.[0]?.sourceIdentities).toEqual([
      `sha256:${"a".repeat(64)}`,
      f.identity,
    ]);
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
        repair: async () => {
          f.advanceIdentity();
        },
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
        repair: async () => {
          f.advanceIdentity();
        },
        rerunQuality: async () => undefined,
        getCurrentContentIdentity: async () => f.identity,
      }),
    ).rejects.toThrow("Unresolved prior finding must remain blocking");
    expect(f.store.read("card")?.reviewRepair?.status).toBe("active");
  });

  it("stops after a completed no-op repair without reviewing unchanged source again", async () => {
    const f = fixture();
    const reviewRun = vi.fn(async () => ({
      review: f.makeReview("fail"),
      contentIdentity: f.identity,
    }));
    const repair = vi.fn(async (review: ImplementationReviewResult) => ({
      version: 1 as const,
      findingDispositions: review.blockingFindings.flatMap(({ id }) =>
        id === undefined
          ? []
          : [
              {
                findingId: id,
                status: "dismissed" as const,
                rationale: "The existing implementation satisfies the task behavior.",
              },
            ],
      ),
      requirementDispositions: review.requirementAssessments
        .filter(({ status }) => status === "unsatisfied")
        .map(({ requirementId }) => ({
          requirementId,
          status: "dismissed" as const,
          rationale: "The existing implementation satisfies this requirement.",
        })),
    }));
    const run = () =>
      runTaskSessionReviewWithRepairs({
        store: f.store,
        maxAttempts: 2,
        projectId: "project",
        cardId: "card",
        operationKey: "operation",
        expectedPrimarySessionId: "primary-session",
        runReview: reviewRun,
        repair,
        rerunQuality: async () => undefined,
        getCurrentContentIdentity: async () => f.identity,
      });
    const result = await run();

    expect(result.review.verdict).toBe("fail");
    expect(result.attempts).toBe(1);
    expect(repair).toHaveBeenCalledOnce();
    expect(reviewRun).toHaveBeenCalledOnce();
    expect(result.record.reviewRepair).toMatchObject({
      status: "exhausted",
      stopReason: "no-change",
      maxAttempts: 2,
      finalReview: { reviewedContentIdentity: f.identity, verdict: "fail" },
      findings: [
        {
          status: "unresolved",
          primaryDisposition: {
            reviewedContentIdentity: f.identity,
            status: "dismissed",
          },
        },
      ],
    });
    expect(
      hasUndisposedReviewConcerns(
        result.review,
        result.record.reviewRepair?.findings ?? [],
        result.record.reviewRepair?.requirementDispositions ?? [],
      ),
    ).toBe(false);
    await run();
    expect(reviewRun).toHaveBeenCalledOnce();
    expect(repair).toHaveBeenCalledOnce();
  });

  it("honors a primary early-finish decision after one current-source review", async () => {
    const f = fixture();
    let reviews = 0;
    const result = await runTaskSessionReviewWithRepairs({
      store: f.store,
      maxAttempts: 3,
      projectId: "project",
      cardId: "card",
      operationKey: "operation",
      expectedPrimarySessionId: "primary-session",
      runReview: async (previousFindings) => {
        reviews += 1;
        return {
          review: {
            ...f.makeReview("fail"),
            blockingFindings:
              previousFindings.length === 0
                ? f.makeReview("fail").blockingFindings
                : previousFindings.map(({ id, kind, summary, detail }) => ({
                    id,
                    kind,
                    summary,
                    detail,
                  })),
            previousFindingAssessments: previousFindings.map(({ id }) => ({
              findingId: id,
              status: "unresolved" as const,
            })),
          },
          contentIdentity: f.identity,
        };
      },
      repair: async (review) => {
        f.advanceIdentity();
        const report = JSON.stringify({
          version: 1,
          findingDispositions: review.blockingFindings.flatMap(({ id }) =>
            id === undefined
              ? []
              : [
                  {
                    findingId: id,
                    status: "dismissed",
                    rationale: "The finding is not material to the request.",
                  },
                ],
          ),
          requirementDispositions: review.requirementAssessments
            .filter(({ status }) => status === "unsatisfied")
            .map(({ requirementId }) => ({
              requirementId,
              status: "dismissed",
              rationale: "The requested behavior is implemented.",
            })),
        });
        const output = JSON.stringify({
          type: "text",
          part: {
            type: "text",
            text: `${report}\n${REVIEW_REPAIR_FINISHED_EARLY_MARKER}`,
          },
        });
        return parsePrimaryReviewRepairOutcome(
          output,
          review.blockingFindings.flatMap(({ id }) => (id === undefined ? [] : [id])),
          review.requirementAssessments
            .filter(({ status }) => status === "unsatisfied")
            .map(({ requirementId }) => requirementId),
        );
      },
      rerunQuality: async () => undefined,
      getCurrentContentIdentity: async () => f.identity,
    });

    expect(reviews).toBe(2);
    expect(result.attempts).toBe(1);
    expect(result.record.reviewRepair).toMatchObject({
      status: "exhausted",
      stopReason: "finished-early",
      maxAttempts: 3,
    });
    const recovered = await runTaskSessionReviewWithRepairs({
      store: f.store,
      maxAttempts: 0,
      projectId: "project",
      cardId: "card",
      operationKey: "operation",
      expectedPrimarySessionId: "primary-session",
      runReview: async () => {
        reviews += 1;
        return { review: f.makeReview("fail"), contentIdentity: f.identity };
      },
      repair: async () => undefined,
      rerunQuality: async () => undefined,
      getCurrentContentIdentity: async () => f.identity,
    });
    expect(recovered.attempts).toBe(1);
    expect(reviews).toBe(2);
  });

  it("ends a no-op review correction even when subsequent quality work changes source", async () => {
    const f = fixture();
    let reviews = 0;
    const repair = vi.fn(async () => undefined);
    const result = await runTaskSessionReviewWithRepairs({
      store: f.store,
      maxAttempts: 3,
      projectId: "project",
      cardId: "card",
      operationKey: "operation",
      expectedPrimarySessionId: "primary-session",
      runReview: async (previousFindings) => {
        reviews += 1;
        return {
          review: {
            ...f.makeReview("fail"),
            blockingFindings:
              previousFindings.length === 0
                ? f.makeReview("fail").blockingFindings
                : previousFindings.map(({ id, kind, summary, detail }) => ({
                    id,
                    kind,
                    summary,
                    detail,
                  })),
            previousFindingAssessments: previousFindings.map(({ id }) => ({
              findingId: id,
              status: "unresolved" as const,
            })),
          },
          contentIdentity: f.identity,
        };
      },
      repair,
      rerunQuality: async () => {
        f.advanceIdentity();
      },
      getCurrentContentIdentity: async () => f.identity,
    });
    expect(repair).toHaveBeenCalledOnce();
    expect(reviews).toBe(2);
    expect(result.record.reviewRepair).toMatchObject({
      status: "exhausted",
      stopReason: "no-change",
      maxAttempts: 3,
    });
    expect(result.review.reviewedContentIdentity).toBe(f.identity);
  });

  it("carries the same review budget across two CI correction handoffs", async () => {
    const f = fixture();
    const cycleId = "operation:ci-review:operation:ci";
    const operationIds: string[] = [];
    let firstCycleReviewCalls = 0;
    const firstCycle = await runTaskSessionReviewWithRepairs({
      store: f.store,
      maxAttempts: 2,
      projectId: "project",
      cardId: "card",
      operationKey: "operation",
      reviewCycleId: cycleId,
      expectedPrimarySessionId: "primary-session",
      runReview: async (previousFindings) => {
        const remainsNegative = firstCycleReviewCalls++ === 0;
        const review = f.makeReview(remainsNegative ? "fail" : "pass");
        return {
          review: {
            ...review,
            blockingFindings: remainsNegative ? review.blockingFindings : [],
            previousFindingAssessments: previousFindings.map(({ id, status }) => ({
              findingId: id,
              status:
                remainsNegative && status === "unresolved"
                  ? ("unresolved" as const)
                  : ("resolved" as const),
            })),
          },
          contentIdentity: f.identity,
        };
      },
      repair: async (_review, _attempt, operationId) => {
        operationIds.push(operationId);
        f.advanceIdentity();
      },
      rerunQuality: async () => undefined,
      getCurrentContentIdentity: async () => f.identity,
    });
    expect(firstCycle.attempts).toBe(1);
    expect(firstCycle.record.reviewRepair).toMatchObject({
      status: "passed",
      maxAttempts: 2,
      cycleId,
    });

    const current = f.store.read("card")!;
    const retained = carryReviewRepairIntoCiCorrection(current.reviewRepair, cycleId);
    expect(retained).toMatchObject({
      cycleId,
      maxAttempts: 2,
      findings: [{ status: "resolved" }],
    });
    f.store.compareAndSwap("card", current.revision, {
      ...current,
      reviewRepair: {
        ...retained!,
        status: "active",
        stopReason: undefined,
        finalReview: undefined,
      },
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    f.advanceIdentity();

    let secondReviewCalls = 0;
    const secondCycle = await runTaskSessionReviewWithRepairs({
      store: f.store,
      maxAttempts: 0,
      projectId: "project",
      cardId: "card",
      operationKey: "operation",
      reviewCycleId: cycleId,
      expectedPrimarySessionId: "primary-session",
      runReview: async (previousFindings) => {
        const remainsNegative = secondReviewCalls++ === 0;
        const review = f.makeReview(remainsNegative ? "fail" : "pass");
        return {
          review: {
            ...review,
            blockingFindings: remainsNegative ? review.blockingFindings : [],
            previousFindingAssessments: previousFindings.map(({ id }) => ({
              findingId: id,
              status: "resolved" as const,
            })),
          },
          contentIdentity: f.identity,
        };
      },
      repair: async (_review, _attempt, operationId) => {
        operationIds.push(operationId);
        f.advanceIdentity();
        return { finishedEarly: false };
      },
      rerunQuality: async () => undefined,
      getCurrentContentIdentity: async () => f.identity,
    });

    expect(operationIds).toEqual([
      "operation:review:operation:ci-review:operation:ci:pass:1",
      "operation:review:operation:ci-review:operation:ci:pass:2",
    ]);
    expect(secondCycle.attempts).toBe(2);
    expect(secondCycle.record.reviewRepair).toMatchObject({
      cycleId,
      maxAttempts: 2,
      status: "passed",
    });
    expect(secondCycle.record.retryCounters.review).toBe(2);
  });

  it("rejects junk after the exact finish marker without extracting a hidden report", () => {
    const report = JSON.stringify({
      version: 1,
      findingDispositions: [],
      requirementDispositions: [],
    });
    const output = JSON.stringify({
      type: "text",
      part: {
        type: "text",
        text: `${report}\n${REVIEW_REPAIR_FINISHED_EARLY_MARKER}\njunk`,
      },
    });

    expect(parsePrimaryReviewRepairOutcome(output, [], [])).toEqual({
      finishedEarly: false,
    });
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
        findings: [{ id: expect.stringMatching(/^finding-/), status: "unresolved" }],
      });
      const persistedFindingId = f.store.read("card")?.reviewRepair?.findings?.[0]?.id;
      const restored = new TaskExecutionStore(path.join(root, "state"), {
        id: "project",
        repository: {
          path: path.join(root, "repo"),
          worktreeRoot: path.join(root, "worktrees"),
        },
      } as ProjectConfig);
      expect(restored.read("card")?.reviewRepair?.findings?.[0]?.id).toBe(persistedFindingId);
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
      const diagnostic = (failure as TaskSessionReviewRepairError).sourceIdentity;
      expect(diagnostic).toEqual({
        before: f.identity,
        after: currentIdentity,
        unchanged: !changed,
      });
      expect(repair).toHaveBeenCalledOnce();
      expect(f.store.read("card")?.reviewRepair?.status).toBe("active");
      expect(f.store.read("card")?.retryCounters.review).toBe(1);
      expect(f.store.read("card")?.reviewRepair?.activePrimaryOperation).toMatchObject({
        operationId: "operation:review:operation:pass:1",
        pass: 1,
      });
      expect(f.store.read("card")?.reviewRemediationFailure).toBeUndefined();
      const restored = new TaskExecutionStore(path.join(root, "state"), {
        id: "project",
        repository: {
          path: path.join(root, "repo"),
          worktreeRoot: path.join(root, "worktrees"),
        },
      } as ProjectConfig);
      expect(restored.read("card")?.reviewRepair?.activePrimaryOperation).toMatchObject({
        operationId: "operation:review:operation:pass:1",
        pass: 1,
      });
      expect(restored.read("card")?.reviewRemediationFailure).toBeUndefined();
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
