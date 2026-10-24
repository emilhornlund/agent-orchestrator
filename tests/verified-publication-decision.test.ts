import { describe, expect, it } from "vitest";
import type { ImplementationReviewResult } from "../src/task-session/implementation-review-result.js";
import type { TaskSessionValidationResult } from "../src/task-session/run-task-session-validation.js";
import { decideVerifiedPublication } from "../src/task-session/verified-publication-decision.js";

const identity = `sha256:${"a".repeat(64)}`;
const validation: TaskSessionValidationResult = {
  command: "yarn validate",
  startedAt: "2026-10-24T09:00:00.000Z",
  completedAt: "2026-10-24T09:01:00.000Z",
  exitCode: 0,
  status: "passed",
  timedOut: false,
  aborted: false,
  diagnostic: "passed",
  contentIdentity: identity,
};
const coverage: TaskSessionValidationResult = {
  ...validation,
  command: "yarn coverage",
};
const review: ImplementationReviewResult = {
  version: 1,
  projectId: "project",
  cardId: "card",
  verdict: "pass",
  requirementAssessments: [
    {
      requirementId: "REQ-1",
      status: "satisfied",
      details: "Implemented and tested",
      evidence: ["src/feature.ts", "tests/feature.test.ts"],
    },
  ],
  blockingFindings: [],
  reviewedContentIdentity: identity,
};

function input(
  overrides: Partial<Parameters<typeof decideVerifiedPublication>[0]> = {},
) {
  return {
    currentContentIdentity: identity,
    validationCommand: "yarn validate",
    validation,
    coverage: null,
    review,
    ...overrides,
  };
}

describe("decideVerifiedPublication", () => {
  it("allows publication only with current passing validation and review", () => {
    expect(decideVerifiedPublication(input())).toEqual({
      allowed: true,
      reasons: [],
      contentIdentity: identity,
    });
  });

  it.each([
    ["validation missing", { validation: null }],
    ["review missing", { review: null }],
    [
      "failed validation",
      { validation: { ...validation, status: "failed" as const, exitCode: 1 } },
    ],
    [
      "failed review",
      {
        review: {
          ...review,
          verdict: "fail" as const,
          blockingFindings: [
            { kind: "defect" as const, summary: "Bug", detail: "Broken" },
          ],
        },
      },
    ],
    [
      "stale validation",
      {
        validation: {
          ...validation,
          contentIdentity: `sha256:${"b".repeat(64)}`,
        },
      },
    ],
    [
      "stale review",
      {
        review: {
          ...review,
          reviewedContentIdentity: `sha256:${"b".repeat(64)}`,
        },
      },
    ],
  ])("denies publication for %s", (_case, override) => {
    expect(decideVerifiedPublication(input(override)).allowed).toBe(false);
  });

  it("requires configured coverage and rejects stale evidence after a source edit", () => {
    expect(
      decideVerifiedPublication(
        input({ coverageCommand: "yarn coverage", coverage }),
      ).allowed,
    ).toBe(true);
    expect(
      decideVerifiedPublication(
        input({ currentContentIdentity: `sha256:${"b".repeat(64)}` }),
      ),
    ).toMatchObject({
      allowed: false,
      reasons: [
        "Local validation evidence is stale",
        "Final implementation review is stale",
      ],
    });
    expect(
      decideVerifiedPublication(
        input({ coverageCommand: "yarn coverage", coverage: null }),
      ).reasons,
    ).toContain("Configured coverage evidence is missing");
  });
});
