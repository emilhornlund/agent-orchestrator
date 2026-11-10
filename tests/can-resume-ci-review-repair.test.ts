import { describe, expect, it } from "vitest";
import { canResumeCiReviewRepair } from "../src/task-session/can-resume-ci-review-repair.js";
import type { TaskExecutionRecord } from "../src/task-session/task-execution-record.js";
import type { TaskMutationEvent } from "../src/task-session/task-mutation-queue.js";

const head = "a".repeat(40);
const cycleId = "task:ci";
const reviewCycleId = `task:ci-review:${cycleId}`;
const reviewOperation = `task:review:${reviewCycleId}:pass:1`;
const ciOperation = `${cycleId}:pass:1`;
const record: TaskExecutionRecord = {
  version: 1,
  revision: 1,
  createdAt: "2026-10-24T09:00:00.000Z",
  updatedAt: "2026-10-24T09:00:00.000Z",
  projectId: "project",
  cardId: "card",
  operationKey: "task",
  phase: "review",
  primarySessionId: "session",
  sessionCreationStatus: "bound",
  pullRequest: {
    number: 1,
    url: "https://github.com/owner/repo/pull/1",
    headSha: head,
  },
  retryCounters: { validation: 0, review: 1, ci: 1, humanFeedback: 0 },
  ciRepair: {
    cycleId,
    status: "active",
    headSha: head,
    activePrimaryOperation: { operationId: ciOperation, pass: 1 },
  },
  reviewRepair: {
    cycleId: reviewCycleId,
    status: "active",
    maxAttempts: 2,
    activePrimaryOperation: {
      operationId: reviewOperation,
      pass: 1,
      promptArtifact: { reference: `sha256:${"b".repeat(64)}`, bytes: 10 },
    },
  },
  primaryOperations: {
    [ciOperation]: {
      id: ciOperation,
      activity: "ci-correction",
      role: "primary",
      status: "completed",
      executions: 1,
      updatedAt: "2026-10-24T09:00:00.000Z",
    },
  },
};
const event: TaskMutationEvent = {
  projectId: "project",
  cardId: "card",
  kind: "ci-repair",
  status: "active",
  eventId: `ci-repair:card:${head}`,
  operationKey: `task:ci:${head}`,
  enqueuedAt: "2026-10-24T09:00:00.000Z",
};

describe("CI review recovery eligibility", () => {
  it.each(["implementation", "validation", "review"] as const)(
    "selects the owned %s checkpoint after CI primary completion",
    (phase) => {
      expect(canResumeCiReviewRepair({ ...record, phase }, event)).toBe(true);
    },
  );

  it("refuses another event, head, cycle or uncompleted primary correction", () => {
    for (const candidate of [
      null,
      { ...event, eventId: "other" },
      { ...event, projectId: "other" },
      { ...event, kind: "feedback" as const },
      { ...event, status: "completed" as const },
    ])
      expect(canResumeCiReviewRepair(record, candidate)).toBe(false);
    for (const update of [
      { pullRequest: { ...record.pullRequest!, headSha: "c".repeat(40) } },
      { primaryOperations: {} },
      {
        primaryOperations: {
          [ciOperation]: {
            ...record.primaryOperations![ciOperation]!,
            status: "ambiguous" as const,
          },
        },
      },
      {
        primaryOperations: {
          [ciOperation]: {
            ...record.primaryOperations![ciOperation]!,
            role: "advisory" as const,
          },
        },
      },
      { reviewRepair: { ...record.reviewRepair!, cycleId: "other" } },
      { retryCounters: { ...record.retryCounters, review: 0 } },
    ])
      expect(canResumeCiReviewRepair({ ...record, ...update }, event)).toBe(
        false,
      );
  });

  it("keeps a reserved review selectable while its own execution is ambiguous", () => {
    expect(
      canResumeCiReviewRepair(
        {
          ...record,
          primaryOperations: {
            ...record.primaryOperations,
            [reviewOperation]: {
              id: reviewOperation,
              activity: "review-correction",
              status: "ambiguous",
              executions: 1,
              updatedAt: "2026-10-24T09:00:00.000Z",
            },
          },
        },
        event,
      ),
    ).toBe(true);
    // Selection is not stopped-execution proof; the production runner must inspect it.
    expect(
      canResumeCiReviewRepair(
        {
          ...record,
          primaryOperations: {
            ...record.primaryOperations,
            [reviewOperation]: {
              id: reviewOperation,
              activity: "another-activity",
              status: "completed",
              executions: 1,
              updatedAt: "2026-10-24T09:00:00.000Z",
            },
          },
        },
        event,
      ),
    ).toBe(false);
  });
});
