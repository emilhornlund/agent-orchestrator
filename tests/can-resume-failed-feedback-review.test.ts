import { describe, expect, it } from "vitest";
import { canResumeFailedFeedbackReview } from "../src/task-session/can-resume-failed-feedback-review.js";
import type { TaskExecutionRecord } from "../src/task-session/task-execution-record.js";
import type { TaskMutationEvent } from "../src/task-session/task-mutation-queue.js";

const eventId = "feedback:head:round";
const record = {
  projectId: "project",
  cardId: "card",
  phase: "review",
  reviewRepair: { status: "exhausted" },
  feedbackRemediation: {
    status: "changed",
    operationId: eventId,
    headSha: "a".repeat(40),
  },
  pullRequest: { headSha: "a".repeat(40) },
} as TaskExecutionRecord;
const active = {
  projectId: "project",
  cardId: "card",
  kind: "feedback",
  eventId,
  status: "failed",
} as TaskMutationEvent;

describe("failed feedback recovery eligibility", () => {
  it("allows a single unconsumed failed checkpoint", () => {
    expect(canResumeFailedFeedbackReview(record, active)).toBe(true);
  });

  it("does not retry after a failed attempt or simulated process restart", () => {
    const consumed = { ...record, feedbackRecoveryAttemptEventId: eventId };
    expect(canResumeFailedFeedbackReview(consumed, active)).toBe(false);
    const restarted = JSON.parse(
      JSON.stringify(consumed),
    ) as TaskExecutionRecord;
    expect(canResumeFailedFeedbackReview(restarted, active)).toBe(false);
    // A later, distinct feedback round can still have its own single recovery.
    const laterEvent = { ...active, eventId: "feedback:new-head:round" };
    const laterRecord = {
      ...consumed,
      feedbackRemediation: {
        ...record.feedbackRemediation!,
        operationId: laterEvent.eventId,
      },
    };
    expect(canResumeFailedFeedbackReview(laterRecord, laterEvent)).toBe(true);
    expect(
      canResumeFailedFeedbackReview(record, { ...active, status: "active" }),
    ).toBe(false);
  });

  it("refuses mismatched event, project, or PR head", () => {
    expect(
      canResumeFailedFeedbackReview(record, { ...active, eventId: "other" }),
    ).toBe(false);
    expect(
      canResumeFailedFeedbackReview(record, { ...active, projectId: "other" }),
    ).toBe(false);
    expect(
      canResumeFailedFeedbackReview(
        {
          ...record,
          pullRequest: {
            number: 1,
            url: "https://github.com/o/r/pull/1",
            headSha: "b".repeat(40),
          },
        },
        active,
      ),
    ).toBe(false);
  });
});
