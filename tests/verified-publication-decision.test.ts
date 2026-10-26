import { describe, expect, it } from "vitest";
import type { ImplementationReviewResult } from "../src/task-session/implementation-review-result.js";
import type { TaskSessionValidationResult } from "../src/task-session/run-task-session-validation.js";
import {
  decideHumanReviewPublication,
  decideValidatedHumanReviewPublication,
  decideVerifiedPublication,
} from "../src/task-session/verified-publication-decision.js";

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

describe("PR-first human-review publication", () => {
  const failedReview: ImplementationReviewResult = {
    ...review,
    verdict: "fail",
    blockingFindings: [
      { kind: "defect", summary: "Unresolved", detail: "Needs human review" },
    ],
  };

  it("allows a human-review PR despite missing or failed quality evidence", () => {
    const failing = input({
      validation: { ...validation, status: "failed", exitCode: 1 },
      coverageCommand: "yarn coverage",
      coverage: null,
      review: failedReview,
    });
    const decision = decideHumanReviewPublication(failing, failedReview);
    expect(decision.allowed).toBe(true);
    expect(decision.reasons).toContain("Local validation did not pass");
    expect(decision.reasons).toContain(
      "Configured coverage evidence is missing",
    );
    expect(decision.reasons).toContain(
      "Final implementation review did not pass",
    );
    expect(decideVerifiedPublication(failing).allowed).toBe(false);
  });

  it("allows a PR with missing, stale, or non-exhausted review evidence", () => {
    const newIdentity = `sha256:${"c".repeat(64)}`;
    const incomplete = input({
      currentContentIdentity: newIdentity,
      validation: null,
      review: null,
    });
    expect(decideHumanReviewPublication(incomplete, undefined).allowed).toBe(
      true,
    );
    expect(
      decideHumanReviewPublication(input({ review: failedReview }), undefined)
        .allowed,
    ).toBe(true);
    expect(decideVerifiedPublication(incomplete).allowed).toBe(false);
  });

  it("still requires a usable source identity to authorize publication", () => {
    const missingIdentity = input({ currentContentIdentity: " " });
    expect(
      decideHumanReviewPublication(missingIdentity, undefined).allowed,
    ).toBe(false);
  });
});

describe("validated advisory review policy", () => {
  it("permits missing and failing AI reviews without weakening automated approval", () => {
    for (const result of [null, { ...review, verdict: "fail" as const }]) {
      expect(
        decideValidatedHumanReviewPublication(input({ review: result }))
          .allowed,
      ).toBe(true);
      expect(decideVerifiedPublication(input({ review: result })).allowed).toBe(
        false,
      );
    }
  });

  it("requires passing local validation and configured coverage", () => {
    expect(
      decideValidatedHumanReviewPublication(input({ validation: null }))
        .allowed,
    ).toBe(false);
    expect(
      decideValidatedHumanReviewPublication(
        input({ validation: { ...validation, status: "failed", exitCode: 1 } }),
      ).allowed,
    ).toBe(false);
    expect(
      decideValidatedHumanReviewPublication(
        input({ coverageCommand: "yarn coverage", coverage: null }),
      ).allowed,
    ).toBe(false);
  });
});
