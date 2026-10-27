import { describe, expect, it } from "vitest";

import {
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
  it("round-trips a complete result bound to the expected source", () => {
    const decoded = JSON.parse(JSON.stringify(result)) as unknown;

    expect(parseImplementationReviewResult(decoded, expected)).toEqual(result);
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
