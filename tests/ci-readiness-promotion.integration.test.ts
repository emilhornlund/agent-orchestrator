import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { notificationAuthorityFixture } from "./support/notification-authority-fixture.js";
import type { ProjectOwnershipLease } from "../src/coordination/project-ownership.js";
import { FeedbackLedgerStore } from "../src/task-session/feedback-ledger-store.js";
import type { TaskExecutionRecord } from "../src/task-session/task-execution-record.js";
import { refreshTaskSessionCiOutcome } from "../src/orchestrator/refresh-task-session-ci-outcome.js";
import { PrMaintenanceStore } from "../src/task-session/pr-maintenance-store.js";
import { implementationReviewResultSchema } from "../src/task-session/implementation-review-result.js";

const roots: string[] = [];
const leases: ProjectOwnershipLease[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const lease of leases.splice(0)) await lease.release();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it.each([
  { scenario: "clean", ready: true },
  { scenario: "unconfigured-quality", ready: true },
  { scenario: "historical-exhaustion", ready: true },
  { scenario: "reused-review", ready: true },
  { scenario: "stale-retained-review", ready: false },
  { scenario: "pending-ci", ready: false },
  { scenario: "failed-validation", ready: false },
  { scenario: "configured-coverage-missing", ready: false },
  { scenario: "material-review-finding", ready: false },
  { scenario: "human-request", ready: false },
] as const)(
  "reconciles draft readiness from current evidence ($scenario)",
  async ({ scenario, ready }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ci-readiness-"));
    roots.push(root);
    const f = await notificationAuthorityFixture(
      root,
      "promotion",
      undefined,
      false,
      "implementation",
    );
    leases.push(f.lease);
    if (scenario === "unconfigured-quality") delete f.project.repository.validationCommand;
    if (scenario === "configured-coverage-missing")
      f.project.repository.coverageCommand = "coverage";
    const contentIdentity = `sha256:${"a".repeat(64)}`;
    const headSha = "b".repeat(40);
    let body = "Human introduction\n";
    vi.spyOn(f.github, "getPullRequestDescription").mockImplementation(async () => body);
    vi.spyOn(f.github, "editPullRequestDescription").mockImplementation(async (options) => {
      expect(options.expectedBody).toBe(body);
      body = options.body;
    });
    const draft = vi.spyOn(f.github, "ensurePullRequestDraft").mockResolvedValue();
    const promote = vi.spyOn(f.github, "ensurePullRequestReady").mockResolvedValue();
    const record: TaskExecutionRecord = {
      version: 1,
      projectId: f.project.id,
      cardId: f.card.id,
      operationKey: "task",
      phase: "human-feedback",
      expectedBranch: "agent/promotion-card",
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      retryCounters: { ci: 0, review: 0, validation: 0, humanFeedback: 0 },
      pullRequest: { number: 1, url: "https://github.com/owner/promotion/pull/1", headSha },
      ...(scenario === "historical-exhaustion"
        ? { ciRepair: { cycleId: "episode", headSha, status: "exhausted" as const } }
        : {}),
      publicationQuality: {
        contentIdentity,
        validation: {
          status:
            scenario === "unconfigured-quality"
              ? "skipped"
              : scenario === "failed-validation"
                ? "failed"
                : "passed",
          command: f.project.repository.validationCommand ?? "",
          exitCode:
            scenario === "unconfigured-quality" ? null : scenario === "failed-validation" ? 1 : 0,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          diagnostic: "Observed check",
          contentIdentity,
        },
        coverageEvidence: {
          status: "skipped",
          command: "",
          exitCode: null,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          diagnostic: "Not configured",
          contentIdentity,
        },
        review: {
          version: 1,
          projectId: f.project.id,
          cardId: f.card.id,
          reviewedContentIdentity: contentIdentity,
          verdict: scenario === "material-review-finding" ? "fail" : "pass",
          requirementAssessments: [],
          blockingFindings:
            scenario === "material-review-finding"
              ? [
                  {
                    id: "finding-1",
                    kind: "defect",
                    summary: "Material issue",
                    detail: "Unresolved correctness concern",
                    location: { filePath: "source.ts", line: 1 },
                  },
                ]
              : [],
        },
      },
    };
    if (scenario === "reused-review" || scenario === "stale-retained-review") {
      const review = implementationReviewResultSchema.parse(record.publicationQuality!.review);
      record.reviewRepair = {
        cycleId: "task:feedback",
        status: "passed",
        maxAttempts: 1,
        finalReview: {
          ...review,
          reviewedContentIdentity:
            scenario === "stale-retained-review" ? `sha256:${"c".repeat(64)}` : contentIdentity,
        },
      };
      record.publicationQuality!.review = null;
    }
    if (scenario === "human-request") {
      await f.authority.run(async () => {
        new FeedbackLedgerStore(f.project.contextRoot, f.project, f.authority).create(f.card.id, [
          {
            kind: "conversation-comment",
            id: "request",
            author: "human",
            body: "Please correct this",
            createdAt: new Date().toISOString(),
            updatedAt: null,
            actionability: "actionable",
            status: "pending",
            verificationEvidence: [],
          },
        ]);
      });
    }
    await f.authority.run(() =>
      refreshTaskSessionCiOutcome({
        project: f.project,
        card: f.card,
        github: f.github,
        record,
        maintenanceStore: new PrMaintenanceStore(f.project.contextRoot, f.project, f.authority),
        evaluation:
          scenario === "pending-ci"
            ? {
                status: "waiting",
                expectedHeadSha: headSha,
                pendingChecks: ["Validate"],
                missingChecks: [],
                diagnostic: "Pending",
              }
            : { status: "passed", expectedHeadSha: headSha, expectedCheckNames: ["Validate"] },
      }),
    );
    expect(promote).toHaveBeenCalledTimes(ready ? 1 : 0);
    expect(draft).toHaveBeenCalledTimes(ready ? 0 : 1);
    expect(body).toContain("Human introduction");
    if (ready)
      expect(promote).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedHeadSha: headSha,
          expectedBody: body,
          headBranch: record.expectedBranch,
        }),
      );
  },
);
