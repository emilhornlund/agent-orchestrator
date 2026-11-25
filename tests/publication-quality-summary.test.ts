import { expect, it } from "vitest";
import {
  publicationQualityFacts,
  ciOutcomeFacts,
  feedbackDispositionFacts,
  reviewConcernFacts,
} from "../src/orchestrator/publication-quality-summary.js";
import type { TaskSessionValidationResult } from "../src/task-session/run-task-session-validation.js";
import { registerProcessSecrets } from "../src/process/process-runtime.js";
import type { ImplementationReviewResult } from "../src/task-session/implementation-review-result.js";

const identity = `sha256:${"a".repeat(64)}`;

it("shows complete long findings with a location, correction and linked requirement without repeating the assessment", () => {
  const finding = {
    kind: "defect" as const,
    summary: "Lock-release errors are omitted",
    detail: `${"The lock can reject after persistence. ".repeat(20)}The caller sees a rejection even though the write succeeded.`,
    location: { filePath: `packages/${"nested-directory/".repeat(22)}scheduler.ts`, line: 73 },
    recommendation: "Document the rejection and what was already persisted.",
    requirementIds: ["REQ-11"],
  };
  const requirement = `${"Document observable failures and their side effects. ".repeat(16)}Include errors raised after a successful write.`;
  const review: ImplementationReviewResult = {
    version: 1,
    cardId: "card",
    projectId: "project",
    verdict: "fail",
    reviewedContentIdentity: identity,
    blockingFindings: [finding, finding],
    requirementAssessments: [
      {
        requirementId: "REQ-11",
        requirement,
        status: "unsatisfied",
        details: finding.detail,
        evidence: [],
      },
    ],
  };
  const facts = reviewConcernFacts(review);
  expect(facts).toHaveLength(2);
  expect(facts[1]).toContain(finding.detail);
  expect(facts[1]).toContain(`${finding.location.filePath}:73`);
  expect(facts[1]).toContain(finding.recommendation);
  expect(facts[1]).toContain(requirement);
  expect(facts[1]).not.toContain("REQ-11");
  const oversized = reviewConcernFacts({
    ...review,
    blockingFindings: [{ ...finding, detail: "Long explanation. ".repeat(600) }],
  });
  expect(oversized[1]).toContain(`${finding.location.filePath}:73`);
  expect(oversized[1]).toContain("Additional details omitted for length.");
  expect(
    reviewConcernFacts({
      ...review,
      verdict: "pass",
      blockingFindings: [],
      requirementAssessments: [],
    }),
  ).toEqual([]);
});
const result: TaskSessionValidationResult = {
  command: "yarn validate",
  status: "passed",
  exitCode: 0,
  startedAt: "2026-11-14T00:00:00Z",
  completedAt: "2026-11-14T00:01:00Z",
  timedOut: false,
  aborted: false,
  diagnostic: "\u001b[31mRAW_DIAGNOSTIC_CANARY\u001b[0m\n".repeat(500),
  contentIdentity: identity,
};

it("renders concise observed checks and artifact references instead of raw result JSON or terminal output", () => {
  const facts = publicationQualityFacts({
    currentContentIdentity: identity,
    validationCommand: "yarn validate && ".repeat(500),
    validation: { ...result, command: "yarn validate && ".repeat(500) },
    coverage: { ...result, command: "", status: "skipped", exitCode: null },
    review: null,
  });
  expect(facts).toEqual([
    "Validation: passed.",
    "Coverage: skipped (not configured).",
    "Independent AI review: unavailable.",
  ]);
  expect(facts.join("\n")).not.toMatch(/RAW_DIAGNOSTIC_CANARY|"diagnostic"|"startedAt"/u);
  expect(facts.join("\n")).not.toContain("\u001b");
  expect(facts.every((fact) => fact.length <= 480 && !fact.includes("\n"))).toBe(true);
});

it.each(["failed", "uncertain", "timed-out", "aborted", "skipped"] as const)(
  "retains configured %s outcomes and stale evidence without claiming success",
  (status) => {
    const facts = publicationQualityFacts({
      currentContentIdentity: identity,
      validationCommand: result.command,
      validation: {
        ...result,
        status,
        exitCode: null,
        contentIdentity: `sha256:${"b".repeat(64)}`,
      },
      coverage: null,
      review: null,
    });
    expect(facts[0]).toContain("Validation: outdated");
    expect(facts[0]).not.toContain("Validation: passed");
  },
);

it("does not call a configured-but-skipped command unconfigured", () => {
  const facts = publicationQualityFacts({
    currentContentIdentity: identity,
    validationCommand: "configured check",
    validation: { ...result, command: "configured check", status: "skipped", exitCode: null },
    coverage: null,
    review: null,
  });
  expect(facts[0]).toContain("Validation: skipped");
  expect(facts[0]).not.toContain("Not configured");
});

it("reports missing and pending CI rather than turning a green subset into a pass", () => {
  const facts = ciOutcomeFacts({
    status: "waiting",
    expectedHeadSha: "a".repeat(40),
    missingChecks: ["Security"],
    pendingChecks: ["Validate"],
    diagnostic: "Waiting for complete checks",
  });
  expect(facts).toEqual(["CI: pending; 1 pending, 1 not yet observed."]);
  expect(facts.join("\n")).not.toContain("Expected checks passed");
});

it("bounds feedback text, redacts known credentials, and keeps unresolved counts visible", () => {
  registerProcessSecrets(["summary-secret-canary"]);
  const facts = feedbackDispositionFacts(
    Array.from({ length: 20 }, (_, index) => ({
      feedbackId: `request-${index}`,
      status: "unresolved" as const,
      reason:
        "\u001b[31msummary-secret-canary\n<!-- agent-orchestrator-status:start -->" +
        "x".repeat(1000),
    })),
  );
  expect(facts[0]).toContain("20 unresolved");
  expect(facts.at(-1)).toContain("15 more unresolved");
  expect(facts.join(" ")).not.toMatch(/summary-secret-canary|<!-- agent-orchestrator/u);
  expect(facts.join(" ")).not.toContain("\u001b");
});
