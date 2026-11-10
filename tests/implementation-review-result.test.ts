import { describe, expect, it } from "vitest";

import {
  hasUndisposedReviewConcerns,
  parseCachedImplementationReviewResult,
  parsePrimaryReviewDispositionReport,
  parseImplementationReviewResult,
  type ImplementationReviewResult,
} from "../src/task-session/implementation-review-result.js";

const contentIdentity = `sha256:${"a".repeat(64)}`;
const expected = {
  projectId: "project-one",
  cardId: "card-one",
  requirementIds: ["REQ-1", "REQ-2"],
  contentIdentity,
} as const;

const result: ImplementationReviewResult = {
  version: 1,
  projectId: expected.projectId,
  cardId: expected.cardId,
  verdict: "pass",
  requirementAssessments: [
    {
      requirementId: "REQ-1",
      status: "satisfied",
      details: "The requested setting persistence is implemented.",
      evidence: ["src/settings.ts", "tests/settings.test.ts"],
    },
    {
      requirementId: "REQ-2",
      status: "satisfied",
      details: "The interface has accessible labels.",
      evidence: ["tests/settings-accessibility.test.ts"],
    },
  ],
  blockingFindings: [],
  reviewedContentIdentity: contentIdentity,
};

describe("parseImplementationReviewResult", () => {
  it("accepts complete primary dispositions and conservatively rejects incomplete reports", () => {
    const output = JSON.stringify({
      version: 1,
      findingDispositions: [
        {
          findingId: "finding-style",
          status: "dismissed",
          rationale:
            "The requested behavior is correct and this preference is not a repository contract.",
        },
        {
          findingId: "finding-defect",
          status: "addressed",
          rationale:
            "Fixed the incorrect persisted-value lookup and added a regression test.",
        },
      ],
      requirementDispositions: [
        {
          requirementId: "REQ-1",
          status: "dismissed",
          rationale:
            "The requirement assessment misread the task; the requested behavior is implemented.",
        },
      ],
    });

    const parsed = parsePrimaryReviewDispositionReport(
      output,
      ["finding-style", "finding-defect"],
      ["REQ-1"],
    );
    expect(parsed?.findingDispositions).toMatchObject([
      { findingId: "finding-style", status: "dismissed" },
      { findingId: "finding-defect", status: "addressed" },
    ]);
    expect(parsed?.requirementDispositions).toMatchObject([
      { requirementId: "REQ-1", status: "dismissed" },
    ]);
    expect(
      parsePrimaryReviewDispositionReport(
        output,
        ["finding-style", "finding-defect", "finding-missing"],
        ["REQ-1"],
      ),
    ).toBeUndefined();
    expect(
      parsePrimaryReviewDispositionReport(
        output,
        ["finding-style", "finding-defect"],
        ["REQ-1", "REQ-2"],
      ),
    ).toBeUndefined();
    expect(
      parsePrimaryReviewDispositionReport("not JSON", ["finding-style"], []),
    ).toBeUndefined();
    const oversized = JSON.stringify({
      version: 1,
      findingDispositions: [],
      requirementDispositions: [
        {
          requirementId: "REQ-1",
          status: "dismissed",
          rationale: "r".repeat(4_001),
        },
      ],
    });
    expect(
      parsePrimaryReviewDispositionReport(oversized, [], ["REQ-1"]),
    ).toBeUndefined();
    expect(
      parsePrimaryReviewDispositionReport(
        JSON.stringify({
          version: 1,
          findingDispositions: [],
          requirementDispositions: [
            {
              requirementId: "REQ-1",
              status: "dismissed",
              rationale: "r".repeat(4_000),
            },
          ],
        }),
        [],
        ["REQ-1"],
      ),
    ).toBeDefined();
  });

  it("lets a content-bound primary requirement dismissal resolve a reviewer-only concern", () => {
    const review: ImplementationReviewResult = {
      ...result,
      verdict: "fail",
      requirementAssessments: [
        {
          requirementId: "REQ-1",
          status: "unsatisfied",
          details: "The reviewer interpreted the requirement incorrectly.",
          evidence: [],
        },
        result.requirementAssessments[1]!,
      ],
    };
    const dismissal = {
      requirementId: "REQ-1",
      reviewedContentIdentity: contentIdentity,
      status: "dismissed" as const,
      rationale:
        "The primary confirms the requirement is implemented in the current source.",
    };

    expect(hasUndisposedReviewConcerns(review, [], [dismissal])).toBe(false);
    expect(hasUndisposedReviewConcerns(review, [], [])).toBe(true);
    expect(
      hasUndisposedReviewConcerns(
        review,
        [],
        [{ ...dismissal, reviewedContentIdentity: `sha256:${"b".repeat(64)}` }],
      ),
    ).toBe(true);
  });

  it("round-trips a complete result bound to the expected source", () => {
    const decoded = JSON.parse(JSON.stringify(result)) as unknown;

    expect(parseImplementationReviewResult(decoded, expected)).toEqual(result);
  });

  it("restores an introduced cached finding without treating its ledger ID as a prior finding", () => {
    const cached = {
      ...result,
      verdict: "fail" as const,
      blockingFindings: [
        {
          id: "finding-ledger-generated",
          sourceContentIdentity: contentIdentity,
          kind: "defect" as const,
          summary: "A current-source defect",
          detail: "The source loses the setting on reload.",
        },
      ],
      previousFindingAssessments: [],
    };
    const cachedExpectations = {
      ...expected,
      previousFindingIds: [],
      previousFindings: [
        {
          id: "finding-ledger-generated",
          sourceContentIdentity: contentIdentity,
          sourceIdentities: [contentIdentity],
          status: "unresolved" as const,
        },
      ],
    };

    expect(
      parseCachedImplementationReviewResult(cached, cachedExpectations),
    ).toEqual(cached);
    expect(() =>
      parseCachedImplementationReviewResult(cached, {
        ...cachedExpectations,
        contentIdentity: `sha256:${"b".repeat(64)}`,
      }),
    ).toThrow("content identity is stale");
  });

  it("accepts legacy cached reviews with prior blocking IDs but no source snapshot", () => {
    const cached = {
      ...result,
      verdict: "fail" as const,
      blockingFindings: [
        {
          id: "finding-prior",
          kind: "defect" as const,
          summary: "The prior defect remains",
          detail:
            "The concrete failure remains present in the reviewed source.",
        },
      ],
      previousFindingAssessments: [
        { findingId: "finding-prior", status: "unresolved" as const },
      ],
    };
    const legacyExpectations = {
      ...expected,
      previousFindingIds: ["finding-prior"],
    };

    expect(
      parseCachedImplementationReviewResult(cached, legacyExpectations),
    ).toEqual(cached);
    expect(() =>
      parseCachedImplementationReviewResult(cached, {
        ...legacyExpectations,
        cardId: "different-card",
      }),
    ).toThrow("task identity does not match");
    expect(() =>
      parseCachedImplementationReviewResult(cached, {
        ...legacyExpectations,
        contentIdentity: `sha256:${"b".repeat(64)}`,
      }),
    ).toThrow("content identity is stale");
  });

  it("retains prior IDs for unresolved findings when validating full-context cached reviews", () => {
    const priorFindingId = "finding-prior";
    const cached = {
      ...result,
      verdict: "fail" as const,
      blockingFindings: [
        {
          id: priorFindingId,
          kind: "defect" as const,
          summary: "The prior defect remains",
          detail: "The same concrete failure remains in the current source.",
        },
      ],
      previousFindingAssessments: [
        { findingId: priorFindingId, status: "unresolved" as const },
      ],
    };

    expect(
      parseCachedImplementationReviewResult(cached, {
        ...expected,
        previousFindingIds: [priorFindingId],
        previousFindings: [
          {
            id: priorFindingId,
            sourceContentIdentity: contentIdentity,
            sourceIdentities: [contentIdentity],
            status: "unresolved",
          },
        ],
      }),
    ).toEqual(cached);
  });

  it("accepts an actionable evidence-backed blocking finding", () => {
    const finding = {
      kind: "incomplete",
      summary: "Settings are lost after reload",
      detail:
        "Defect: settings are held only in memory. Requirement: REQ-1 requires persistence. Evidence: src/settings.ts:12 initializes the value without reading saved state, so reload loses the setting. Expected behavior: restore the saved setting after reload.",
      location: { filePath: "src/settings.ts", line: 12 },
    } as const;

    expect(
      parseImplementationReviewResult(
        {
          ...result,
          verdict: "fail",
          blockingFindings: [finding],
        },
        expected,
      ).blockingFindings,
    ).toEqual([finding]);
  });

  it("continues to recover persisted findings in the existing result shape", () => {
    const persistedResult = {
      ...result,
      verdict: "fail",
      requirementAssessments: [
        { ...result.requirementAssessments[0]!, status: "unsatisfied" },
        result.requirementAssessments[1],
      ],
      blockingFindings: [
        {
          kind: "incomplete",
          summary: "Missing required behavior",
          detail: "The required behavior is incomplete.",
        },
      ],
    };

    expect(parseImplementationReviewResult(persistedResult, expected)).toEqual(
      persistedResult,
    );
  });

  it("rejects missing or duplicate requirement assessments", () => {
    expect(() =>
      parseImplementationReviewResult(
        {
          ...result,
          requirementAssessments: [result.requirementAssessments[0]],
        },
        expected,
      ),
    ).toThrow("omitted requirement assessment");

    expect(() =>
      parseImplementationReviewResult(
        {
          ...result,
          requirementAssessments: [
            ...result.requirementAssessments,
            result.requirementAssessments[0],
          ],
        },
        expected,
      ),
    ).toThrow("Duplicate requirement assessment");
  });

  it("requires a review-owned classification for every prior finding", () => {
    const previous = { ...result, previousFindingAssessments: [] };
    expect(() =>
      parseImplementationReviewResult(previous, {
        ...expected,
        previousFindingIds: ["finding-prior"],
      }),
    ).toThrow("omitted previous finding assessment");

    expect(() =>
      parseImplementationReviewResult(
        {
          ...result,
          previousFindingAssessments: [
            { findingId: "finding-prior", status: "superseded" },
          ],
        },
        { ...expected, previousFindingIds: ["finding-prior"] },
      ),
    ).toThrow("Superseded findings require justification");

    expect(
      parseImplementationReviewResult(
        {
          ...result,
          previousFindingAssessments: [
            {
              findingId: "finding-prior",
              status: "superseded",
              justification:
                "The reported behavior no longer exists in this implementation.",
            },
          ],
        },
        { ...expected, previousFindingIds: ["finding-prior"] },
      ).previousFindingAssessments,
    ).toHaveLength(1);
  });

  it("keeps unresolved prior findings blocking and rejects contradictory verdicts", () => {
    const priorFindingAssessment = {
      findingId: "finding-prior",
      status: "unresolved" as const,
    };
    expect(() =>
      parseImplementationReviewResult(
        {
          ...result,
          previousFindingAssessments: [priorFindingAssessment],
        },
        { ...expected, previousFindingIds: [priorFindingAssessment.findingId] },
      ),
    ).toThrow("Unresolved prior finding must remain in blockingFindings");

    const blockingPriorFinding = {
      id: priorFindingAssessment.findingId,
      kind: "defect" as const,
      summary: "Prior defect remains",
      detail: "The prior blocking defect is still present.",
    };
    expect(() =>
      parseImplementationReviewResult(
        {
          ...result,
          blockingFindings: [blockingPriorFinding],
          previousFindingAssessments: [priorFindingAssessment],
        },
        { ...expected, previousFindingIds: [priorFindingAssessment.findingId] },
      ),
    ).toThrow("cannot contain unsatisfied requirements or blocking findings");

    expect(
      parseImplementationReviewResult(
        {
          ...result,
          verdict: "fail",
          blockingFindings: [blockingPriorFinding],
          previousFindingAssessments: [priorFindingAssessment],
        },
        { ...expected, previousFindingIds: [priorFindingAssessment.findingId] },
      ).blockingFindings,
    ).toEqual([blockingPriorFinding]);

    expect(() =>
      parseImplementationReviewResult(
        {
          ...result,
          verdict: "fail",
          blockingFindings: [blockingPriorFinding],
          previousFindingAssessments: [
            { findingId: priorFindingAssessment.findingId, status: "resolved" },
          ],
        },
        { ...expected, previousFindingIds: [priorFindingAssessment.findingId] },
      ),
    ).toThrow("without new supporting evidence");
  });

  it("requires new current-source evidence to reopen a resolved finding", () => {
    const prior = {
      id: "finding-prior",
      sourceContentIdentity: `sha256:${"b".repeat(64)}`,
      sourceIdentities: [
        `sha256:${"b".repeat(64)}`,
        `sha256:${"c".repeat(64)}`,
      ],
      status: "resolved" as const,
    };
    const nextIdentity = `sha256:${"c".repeat(64)}`;
    const reopenedFinding = {
      id: prior.id,
      sourceContentIdentity: nextIdentity,
      kind: "defect" as const,
      summary: "A regression reintroduced the defect",
      detail:
        "Evidence: src/settings.ts:24 now bypasses the persisted setting and reproduces the prior defect. Expected behavior: use the persisted setting.",
      location: { filePath: "src/settings.ts", line: 24 },
    };
    const reopenedResult = {
      ...result,
      verdict: "fail" as const,
      blockingFindings: [reopenedFinding],
      previousFindingAssessments: [
        { findingId: prior.id, status: "resolved" as const },
      ],
      reviewedContentIdentity: nextIdentity,
    };

    expect(() =>
      parseImplementationReviewResult(reopenedResult, {
        ...expected,
        contentIdentity: nextIdentity,
        previousFindingIds: [prior.id],
        previousFindings: [prior],
      }),
    ).toThrow("without new supporting evidence");

    expect(
      parseImplementationReviewResult(reopenedResult, {
        ...expected,
        contentIdentity: nextIdentity,
        previousFindingIds: [prior.id],
        previousFindings: [
          {
            ...prior,
            sourceIdentities: [`sha256:${"b".repeat(64)}`],
          },
        ],
      }).blockingFindings,
    ).toEqual([reopenedFinding]);
  });

  it("rejects invalid verdicts and inconsistent pass/fail outcomes", () => {
    expect(() =>
      parseImplementationReviewResult(
        { ...result, verdict: "unknown" },
        expected,
      ),
    ).toThrow();

    expect(() =>
      parseImplementationReviewResult(
        {
          ...result,
          requirementAssessments: [
            { ...result.requirementAssessments[0]!, status: "unsatisfied" },
            result.requirementAssessments[1],
          ],
        },
        expected,
      ),
    ).toThrow("cannot contain unsatisfied requirements");

    expect(() =>
      parseImplementationReviewResult({ ...result, verdict: "fail" }, expected),
    ).toThrow("requires an unsatisfied requirement");
  });

  it("rejects stale or mismatched task identities", () => {
    expect(() =>
      parseImplementationReviewResult(
        { ...result, reviewedContentIdentity: `sha256:${"b".repeat(64)}` },
        expected,
      ),
    ).toThrow("content identity is stale");

    expect(() =>
      parseImplementationReviewResult(
        { ...result, cardId: "another-card" },
        expected,
      ),
    ).toThrow("task identity does not match");
  });

  it.each([
    [
      "blank finding summary",
      { kind: "defect", summary: " ", detail: "A defect" },
    ],
    [
      "path traversal location",
      {
        kind: "defect",
        summary: "Unsafe path",
        detail: "The defect is in a path outside the repository.",
        location: { filePath: "../secret.txt", line: 1 },
      },
    ],
    [
      "invalid source line",
      {
        kind: "contract-violation",
        summary: "Invalid source line",
        detail: "Line numbers must be positive.",
        location: { filePath: "src/settings.ts", line: 0 },
      },
    ],
  ])("rejects a malformed blocking finding: %s", (_label, finding) => {
    expect(() =>
      parseImplementationReviewResult(
        { ...result, verdict: "fail", blockingFindings: [finding] },
        expected,
      ),
    ).toThrow();
  });

  it("requires evidence for satisfied requirements and rejects unknown fields", () => {
    expect(() =>
      parseImplementationReviewResult(
        {
          ...result,
          requirementAssessments: [
            { ...result.requirementAssessments[0]!, evidence: [] },
            result.requirementAssessments[1],
          ],
        },
        expected,
      ),
    ).toThrow("require concrete evidence");

    expect(() =>
      parseImplementationReviewResult(
        { ...result, unrecognized: true },
        expected,
      ),
    ).toThrow("Unrecognized key");
  });
});
