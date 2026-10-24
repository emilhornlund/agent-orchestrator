import { describe, expect, it } from "vitest";
import { parseFeedbackVerificationResult } from "../src/task-session/feedback-verification.js";

const expected = {
  projectId: "project",
  cardId: "card",
  headSha: "a".repeat(40),
  contentIdentity: `sha256:${"b".repeat(64)}`,
  actionableFeedbackIds: ["review:1", "inline-comment:2"],
};
const disposition = (feedbackId: string) => ({
  feedbackId,
  status: "verified-fixed",
  evidence: ["source.ts", "test.ts"],
});
const response = {
  version: 1,
  projectId: "project",
  cardId: "card",
  headSha: expected.headSha,
  contentIdentity: expected.contentIdentity,
  dispositions: [
    disposition("review:1"),
    {
      feedbackId: "inline-comment:2",
      status: "unresolved",
      reason: "Requires product decision",
    },
  ],
};

describe("parseFeedbackVerificationResult", () => {
  it("accepts one evidence-backed or unresolved disposition for every actionable item", () => {
    expect(
      parseFeedbackVerificationResult(response, expected).dispositions,
    ).toHaveLength(2);
  });
  it("rejects omitted and invented feedback IDs", () => {
    expect(() =>
      parseFeedbackVerificationResult(
        { ...response, dispositions: [disposition("review:1")] },
        expected,
      ),
    ).toThrow("omitted item");
    expect(() =>
      parseFeedbackVerificationResult(
        {
          ...response,
          dispositions: [...response.dispositions, disposition("invented")],
        },
        expected,
      ),
    ).toThrow("invented item");
  });
  it("rejects results from an earlier PR head or source snapshot", () => {
    expect(() =>
      parseFeedbackVerificationResult(
        { ...response, headSha: "c".repeat(40) },
        expected,
      ),
    ).toThrow("does not match");
    expect(() =>
      parseFeedbackVerificationResult(
        { ...response, contentIdentity: `sha256:${"d".repeat(64)}` },
        expected,
      ),
    ).toThrow("does not match");
  });
});
