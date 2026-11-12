import { describe, expect, it } from "vitest";
import {
  canResumeFailedFeedbackReview,
  canResumeFeedbackReviewRepair,
} from "../src/task-session/can-resume-failed-feedback-review.js";
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
  const cycleId = `task:feedback:${eventId}`;
  const operationId = `task:review:${cycleId}:pass:1`;
  const ownedRecord = {
    ...record,
    operationKey: "task",
    primarySessionId: "session",
    sessionCreationStatus: "bound" as const,
    retryCounters: { validation: 0, review: 1, ci: 0, humanFeedback: 0 },
    reviewRepair: {
      cycleId,
      status: "active" as const,
      maxAttempts: 2,
      activePrimaryOperation: {
        operationId,
        pass: 1,
        promptArtifact: { reference: `sha256:${"a".repeat(64)}`, bytes: 10 },
      },
    },
  } as TaskExecutionRecord;
  const ownedEvent = {
    ...active,
    status: "active" as const,
    operationKey: eventId,
  };

  it.each(["review", "implementation", "validation"] as const)(
    "selects a reserved feedback review in %s without assuming the execution stopped",
    (phase) => {
      expect(canResumeFeedbackReviewRepair({ ...ownedRecord, phase }, ownedEvent)).toBe(true);
    },
  );

  it("does not select a mismatched queue, head, cycle, prompt or operation", () => {
    for (const event of [
      null,
      { ...ownedEvent, cardId: "other" },
      { ...ownedEvent, projectId: "other" },
      { ...ownedEvent, kind: "ci-repair" as const },
      { ...ownedEvent, status: "completed" as const },
    ])
      expect(canResumeFeedbackReviewRepair(ownedRecord, event)).toBe(false);
    const repair = ownedRecord.reviewRepair!;
    for (const update of [
      { pullRequest: { ...ownedRecord.pullRequest!, headSha: "b".repeat(40) } },
      { reviewRepair: { ...repair, cycleId: "other" } },
      {
        reviewRepair: {
          ...repair,
          activePrimaryOperation: {
            ...repair.activePrimaryOperation!,
            promptArtifact: undefined,
          },
        },
      },
      { retryCounters: { ...ownedRecord.retryCounters, review: 0 } },
      {
        primaryOperations: {
          [operationId]: {
            id: operationId,
            role: "advisory" as const,
            activity: "plan-review",
            executions: 1,
            status: "ambiguous" as const,
            updatedAt: "2026-10-24T09:00:00.000Z",
          },
        },
      },
    ])
      expect(canResumeFeedbackReviewRepair({ ...ownedRecord, ...update }, ownedEvent)).toBe(false);
  });

  it("keeps failed exhausted review under the existing one-shot recovery rule", () => {
    const exhausted = {
      ...ownedRecord,
      reviewRepair: {
        ...ownedRecord.reviewRepair!,
        status: "exhausted" as const,
        activePrimaryOperation: undefined,
      },
    };
    expect(
      canResumeFeedbackReviewRepair(exhausted, {
        ...ownedEvent,
        status: "failed",
      }),
    ).toBe(false);
    expect(
      canResumeFailedFeedbackReview(exhausted, {
        ...ownedEvent,
        status: "failed",
      }),
    ).toBe(true);
  });

  it("allows a single unconsumed failed checkpoint", () => {
    expect(canResumeFailedFeedbackReview(record, active)).toBe(true);
  });

  it("does not retry after a failed attempt or simulated process restart", () => {
    const consumed = { ...record, feedbackRecoveryAttemptEventId: eventId };
    expect(canResumeFailedFeedbackReview(consumed, active)).toBe(false);
    const restarted = JSON.parse(JSON.stringify(consumed)) as TaskExecutionRecord;
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
    expect(canResumeFailedFeedbackReview(record, { ...active, status: "active" })).toBe(false);
  });

  it("refuses mismatched event, project, or PR head", () => {
    expect(canResumeFailedFeedbackReview(record, { ...active, eventId: "other" })).toBe(false);
    expect(canResumeFailedFeedbackReview(record, { ...active, projectId: "other" })).toBe(false);
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
