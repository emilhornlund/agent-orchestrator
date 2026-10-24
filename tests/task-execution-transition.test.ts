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
  it.each([
    ["planning", "plan-approved", "implementation"],
    ["implementation", "implementation-completed", "validation"],
    ["validation", "validation-passed", "review"],
    ["validation", "validation-failed", "implementation"],
    ["review", "review-passed", "publication"],
    ["review", "review-failed", "implementation"],
    ["publication", "publication-completed", "ci"],
    ["ci", "ci-passed-awaiting-human", "human-feedback"],
    ["ci", "ci-passed-completed", "done"],
    ["ci", "ci-failed", "implementation"],
    ["human-feedback", "feedback-received", "implementation"],
  ] as const)("advances %s on %s to %s", (phase, eventType, expectedPhase) => {
    const nextRecord = transitionTaskExecutionRecord(
      createRecord(phase),
      createEvent(eventType),
    );

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

  it("treats the same latest event as idempotent", () => {
    const record = createRecord("planning");
    const event = createEvent("plan-approved");
    const transitioned = transitionTaskExecutionRecord(record, event);

    expect(transitionTaskExecutionRecord(transitioned, event)).toEqual(
      transitioned,
    );
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
      transitionTaskExecutionRecord(
        createRecord("planning"),
        createEvent("review-passed"),
      ),
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
