import { describe, expect, it } from "vitest";

import {
  type TaskExecutionPhase,
  type TaskExecutionRecord,
} from "../src/task-session/task-execution-record.js";
import {
  TaskExecutionTransitionError,
  transitionTaskExecutionRecord,
  type TaskExecutionEvent,
} from "../src/task-session/task-execution-transition.js";

const timestamp = "2026-10-24T09:01:00.000Z";

function createRecord(phase: TaskExecutionPhase): TaskExecutionRecord {
  return {
    version: 1,
    projectId: "project-one",
    cardId: "card-one",
    phase,
    primarySessionId: "session-one",
    expectedBranch: "agent/card-one",
    ...(phase === "ci" || phase === "human-feedback" || phase === "done"
      ? {
          pullRequest: {
            number: 42,
            url: "https://github.com/owner/repository/pull/42",
            headSha: "a".repeat(40),
          },
        }
      : {}),
    operationKey: "operation-one",
    revision: 1,
    retryCounters: {
      validation: 0,
      review: 0,
      ci: 0,
      humanFeedback: 0,
    },
    createdAt: "2026-10-24T09:00:00.000Z",
    updatedAt: "2026-10-24T09:00:00.000Z",
  };
}

function createEvent(
  type: TaskExecutionEvent["type"],
  overrides: Partial<TaskExecutionEvent> = {},
): TaskExecutionEvent {
  return {
    type,
    eventId: `event-${type}`,
    projectId: "project-one",
    cardId: "card-one",
    operationKey: "operation-one",
    occurredAt: timestamp,
    ...(type === "publication-completed"
      ? {
          pullRequest: {
            number: 42,
            url: "https://github.com/owner/repository/pull/42",
            headSha: "a".repeat(40),
          },
        }
      : {}),
    ...overrides,
  } as TaskExecutionEvent;
}

describe("transitionTaskExecutionRecord", () => {
  it.each(["passed", "stopped", "exhausted"] as const)(
    "preserves a %s CI repair checkpoint during attention-required recovery",
    (status) => {
      const record: TaskExecutionRecord = {
        ...createRecord("human-feedback"),
        retryCounters: {
          ...createRecord("human-feedback").retryCounters,
          ci: status === "exhausted" ? 2 : 0,
        },
        ciRepair: {
          cycleId: "operation-one:ci",
          headSha: "a".repeat(40),
          status,
          ...(status === "stopped" ? { stopReason: "no-change" } : {}),
        },
      };
      const next = transitionTaskExecutionRecord(record, createEvent("attention-required"));
      expect(next.phase).toBe("attention-required");
      expect(next.ciRepair).toEqual(record.ciRepair);
      expect(next.pullRequest).toEqual(record.pullRequest);
    },
  );

  it.each(["implementation", "validation", "review", "ci", "attention-required"] as const)(
    "retires interrupted repairs on verified human merge from %s without fabricating passed checks",
    (phase) => {
      const record: TaskExecutionRecord = {
        ...createRecord("ci"),
        phase,
        reviewRepair: { cycleId: "operation-one:ci-review", status: "active", maxAttempts: 3 },
        ciRepair: { cycleId: "operation-one:ci", status: "active", headSha: "a".repeat(40) },
        ...(phase === "validation"
          ? { validationRepair: { cycleId: "operation-one:validation", status: "active" as const } }
          : {}),
        terminalInterruption: {
          state: "MERGED",
          pullRequestUrl: "https://github.com/owner/repository/pull/42",
          headSha: "a".repeat(40),
          previousPhase: phase,
          artifact: { reference: `sha256:${"b".repeat(64)}`, bytes: 10 },
        },
      };
      const completed = transitionTaskExecutionRecord(record, createEvent("pull-request-merged"));
      expect(completed.phase).toBe("done");
      expect(completed.reviewRepair).toBeUndefined();
      expect(completed.ciRepair).toBeUndefined();
      expect(completed.validationRepair).toBeUndefined();
      expect(completed.terminalInterruption).toEqual(record.terminalInterruption);
      expect(completed.retryCounters).toEqual(record.retryCounters);
      expect(record.reviewRepair?.status).toBe("active");
      expect(() =>
        transitionTaskExecutionRecord(
          { ...record, terminalInterruption: undefined },
          createEvent("pull-request-merged"),
        ),
      ).toThrow("retained interrupted task snapshot");
    },
  );

  it("requires the completed owned primary and unchanged source to end CI without publication", () => {
    const identity = `sha256:${"a".repeat(64)}`;
    const cycleId = "operation-one:ci";
    const operationId = `${cycleId}:pass:1`;
    const record: TaskExecutionRecord = {
      ...createRecord("ci"),
      retryCounters: { ...createRecord("ci").retryCounters, ci: 1 },
      ciRepair: {
        cycleId,
        status: "active",
        headSha: "a".repeat(40),
        activePrimaryOperation: { operationId, pass: 1, sourceIdentity: identity },
      },
      primaryOperations: {
        [operationId]: {
          id: operationId,
          activity: "ci-correction",
          role: "primary",
          status: "completed",
          executions: 1,
          updatedAt: timestamp,
          result: { exitCode: 0, output: "CI_REPAIR_FINISHED_EARLY", errorOutput: "" },
        },
      },
    };
    const event = createEvent("ci-repair-ended", {
      reason: "no-change",
      contentIdentity: identity,
    });
    expect(transitionTaskExecutionRecord(record, event)).toMatchObject({
      phase: "human-feedback",
      ciRepair: { status: "stopped", stopReason: "no-change" },
    });
    expect(() =>
      transitionTaskExecutionRecord(record, {
        ...event,
        type: "ci-repair-ended",
        reason: "no-change",
        contentIdentity: `sha256:${"b".repeat(64)}`,
      }),
    ).toThrow("completed unchanged correction");
    expect(() =>
      transitionTaskExecutionRecord({ ...record, primaryOperations: {} }, event),
    ).toThrow("completed unchanged correction");
    expect(() =>
      transitionTaskExecutionRecord(
        {
          ...record,
          primaryOperations: {
            [operationId]: { ...record.primaryOperations![operationId]!, role: "advisory" },
          },
        },
        event,
      ),
    ).toThrow("completed unchanged correction");
    expect(() =>
      transitionTaskExecutionRecord(
        { ...record, phase: "validation" },
        createEvent("ci-repair-ended", { reason: "finished-early" }),
      ),
    ).toThrow("owned PR");
  });

  it("preserves changed feedback-remediation ownership across correction phases", () => {
    const changedFeedback = {
      operationId: "feedback:requested-change",
      status: "changed" as const,
      headSha: "a".repeat(40),
      ledgerRevision: 2,
    };
    let record: TaskExecutionRecord = {
      ...createRecord("human-feedback"),
      feedbackRemediation: changedFeedback,
    };

    for (const type of [
      "feedback-received",
      "implementation-completed",
      "validation-passed",
      "review-passed",
      "publication-completed",
    ] as const) {
      record = transitionTaskExecutionRecord(record, createEvent(type));
      expect(record.feedbackRemediation).toEqual(changedFeedback);
    }
    expect(record.phase).toBe("ci");
  });

  it("clears only active feedback remediation when leaving human feedback", () => {
    const record = {
      ...createRecord("human-feedback"),
      feedbackRemediation: {
        operationId: "feedback:active",
        status: "active" as const,
        headSha: "a".repeat(40),
        ledgerRevision: 1,
      },
    };

    const nextRecord = transitionTaskExecutionRecord(record, createEvent("feedback-received"));

    expect(nextRecord.phase).toBe("implementation");
    expect(nextRecord.feedbackRemediation).toBeUndefined();
  });

  it("hands off unchanged interrupted review repair without inventing a verdict", () => {
    let record = createRecord("implementation");
    for (const type of [
      "implementation-completed",
      "validation-passed",
      "review-unavailable",
    ] as const) {
      record = transitionTaskExecutionRecord(
        record,
        createEvent(type, {
          eventId: `recovery-${type}`,
          occurredAt: new Date(Date.parse(record.updatedAt) + 1_000).toISOString(),
        }),
      );
    }
    expect(record.phase).toBe("publication");
    expect(record.reviewRepair?.finalReview).toBeUndefined();
    expect(record.lastEvent?.type).toBe("review-unavailable");
  });

  it.each([
    ["planning", "plan-approved", "implementation"],
    ["implementation", "implementation-completed", "validation"],
    ["validation", "validation-passed", "review"],
    ["validation", "validation-exhausted", "publication"],
    ["validation", "validation-failed", "implementation"],
    ["review", "review-passed", "publication"],
    ["review", "review-unavailable", "publication"],
    ["review", "review-failed", "implementation"],
    ["implementation", "review-failed", "implementation"],
    ["publication", "publication-completed", "ci"],
    ["ci", "ci-passed-awaiting-human", "human-feedback"],
    ["ci", "ci-passed-completed", "done"],
    ["ci", "pull-request-merged", "done"],
    ["ci", "ci-failed", "implementation"],
    ["human-feedback", "feedback-received", "implementation"],
    ["human-feedback", "feedback-ci-failed", "ci"],
    ["human-feedback", "feedback-replies-published", "ci"],
    ["human-feedback", "pull-request-merged", "done"],
  ] as const)("advances %s on %s to %s", (phase, eventType, expectedPhase) => {
    const nextRecord = transitionTaskExecutionRecord(createRecord(phase), createEvent(eventType));

    expect(nextRecord.phase).toBe(expectedPhase);
    expect(nextRecord.revision).toBe(2);
    expect(nextRecord.updatedAt).toBe(timestamp);
    expect(nextRecord.lastEvent).toEqual({
      id: `event-${eventType}`,
      type: eventType,
      operationKey: "operation-one",
      occurredAt: timestamp,
      ...(eventType === "publication-completed"
        ? {
            pullRequest: {
              number: 42,
              url: "https://github.com/owner/repository/pull/42",
              headSha: "a".repeat(40),
            },
          }
        : {}),
    });
  });

  it.each([
    "planning",
    "implementation",
    "validation",
    "review",
    "publication",
    "ci",
    "human-feedback",
  ] as const)("can move %s to attention-required", (phase) => {
    const nextRecord = transitionTaskExecutionRecord(
      createRecord(phase),
      createEvent("attention-required"),
    );

    expect(nextRecord.phase).toBe("attention-required");
  });

  it("does not allow exhausted validation to bypass implementation ownership", () => {
    expect(() =>
      transitionTaskExecutionRecord(
        createRecord("implementation"),
        createEvent("validation-exhausted"),
      ),
    ).toThrow("not allowed during the implementation phase");
  });

  it("treats the same latest event as idempotent", () => {
    const record = createRecord("planning");
    const event = createEvent("plan-approved");
    const transitioned = transitionTaskExecutionRecord(record, event);

    expect(transitionTaskExecutionRecord(transitioned, event)).toEqual(transitioned);
    expect(transitioned.revision).toBe(2);
  });

  it("rejects event-ID reuse with different event content", () => {
    const transitioned = transitionTaskExecutionRecord(
      createRecord("planning"),
      createEvent("plan-approved"),
    );

    expect(() =>
      transitionTaskExecutionRecord(
        transitioned,
        createEvent("plan-approved", {
          occurredAt: "2026-10-24T09:02:00.000Z",
        }),
      ),
    ).toThrow("reused with different content");
  });

  it.each([
    ["another project", { projectId: "project-two" }],
    ["another card", { cardId: "card-two" }],
    ["a stale operation", { operationKey: "operation-two" }],
  ])("rejects an event for %s", (_description, overrides) => {
    expect(() =>
      transitionTaskExecutionRecord(
        createRecord("planning"),
        createEvent("plan-approved", overrides),
      ),
    ).toThrow(TaskExecutionTransitionError);
  });

  it("rejects an event from the wrong phase and an old timestamp", () => {
    expect(() =>
      transitionTaskExecutionRecord(createRecord("planning"), createEvent("review-passed")),
    ).toThrow("not allowed during the planning phase");
    expect(() =>
      transitionTaskExecutionRecord(
        createRecord("planning"),
        createEvent("plan-approved", {
          occurredAt: "2026-10-24T08:59:00.000Z",
        }),
      ),
    ).toThrow("earlier than the record update timestamp");
  });

  it.each(["done", "attention-required"] as const)(
    "does not allow transitions out of terminal phase %s",
    (phase) => {
      expect(() =>
        transitionTaskExecutionRecord(
          createRecord(phase),
          createEvent("attention-required", {
            eventId: "new-attention-event",
          }),
        ),
      ).toThrow("terminal phase");
    },
  );
});
