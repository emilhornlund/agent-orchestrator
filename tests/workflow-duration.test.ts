import { describe, expect, it } from "vitest";

import {
  formatWorkflowDuration,
  selectAutomatedWorkflowPass,
} from "../src/orchestrator/workflow-duration.js";
import type { TrelloListTransition } from "../src/trello/trello-client.js";

const listIds = {
  ready: "ready",
  working: "working",
  review: "review",
  failed: "failed",
} as const;

function transition(
  id: string,
  listBeforeId: string,
  listAfterId: string,
  date: string,
): TrelloListTransition {
  return { id, listBeforeId, listAfterId, date };
}

function select(transitions: TrelloListTransition[]) {
  return selectAutomatedWorkflowPass(transitions, {
    readyListId: listIds.ready,
    workingListId: listIds.working,
    reviewListId: listIds.review,
    failedListId: listIds.failed,
  });
}

describe("selectAutomatedWorkflowPass", () => {
  it("selects the initial Ready for Agent to Human Review pass", () => {
    const result = select([
      transition(
        "end",
        listIds.working,
        listIds.review,
        "2026-08-30T11:00:00.000Z",
      ),
      transition(
        "start",
        listIds.ready,
        listIds.working,
        "2026-08-30T10:00:00.000Z",
      ),
    ]);

    expect(result).toEqual({
      pass: {
        startTransition: expect.objectContaining({ id: "start" }),
        endTransition: expect.objectContaining({ id: "end" }),
        durationMilliseconds: 3_600_000,
      },
    });
  });

  it("starts a retried pass at Failed to Ready for Agent", () => {
    const result = select([
      transition(
        "first-start",
        listIds.ready,
        listIds.working,
        "2026-08-30T09:00:00.000Z",
      ),
      transition(
        "failed",
        listIds.working,
        listIds.failed,
        "2026-08-30T09:30:00.000Z",
      ),
      transition(
        "retry-ready",
        listIds.failed,
        listIds.ready,
        "2026-08-30T12:00:00.000Z",
      ),
      transition(
        "retry-start",
        listIds.ready,
        listIds.working,
        "2026-08-30T12:05:00.000Z",
      ),
      transition(
        "end",
        listIds.working,
        listIds.review,
        "2026-08-30T13:00:00.000Z",
      ),
    ]);

    expect(result).toEqual({
      pass: {
        startTransition: expect.objectContaining({ id: "retry-ready" }),
        endTransition: expect.objectContaining({ id: "end" }),
        durationMilliseconds: 3_600_000,
      },
    });
  });

  it("measures only the current review-feedback remediation pass", () => {
    const result = select([
      transition(
        "initial-start",
        listIds.ready,
        listIds.working,
        "2026-08-30T09:00:00.000Z",
      ),
      transition(
        "initial-end",
        listIds.working,
        listIds.review,
        "2026-08-30T10:00:00.000Z",
      ),
      transition(
        "feedback-start",
        listIds.review,
        listIds.working,
        "2026-08-31T09:00:00.000Z",
      ),
      transition(
        "feedback-end",
        listIds.working,
        listIds.review,
        "2026-08-31T09:07:05.000Z",
      ),
    ]);

    expect(result).toEqual({
      pass: {
        startTransition: expect.objectContaining({ id: "feedback-start" }),
        endTransition: expect.objectContaining({ id: "feedback-end" }),
        durationMilliseconds: 425_000,
      },
    });
  });

  it.each([
    {
      name: "missing start history",
      transitions: [
        transition(
          "end",
          listIds.working,
          listIds.review,
          "2026-08-30T11:00:00.000Z",
        ),
      ],
      reason: "no transition into working",
    },
    {
      name: "missing end history",
      transitions: [
        transition(
          "start",
          listIds.ready,
          listIds.working,
          "2026-08-30T10:00:00.000Z",
        ),
      ],
      reason: "no working -> review transition",
    },
    {
      name: "malformed timestamp",
      transitions: [
        transition("bad", listIds.ready, listIds.working, "not-a-date"),
        transition(
          "end",
          listIds.working,
          listIds.review,
          "2026-08-30T11:00:00.000Z",
        ),
      ],
      reason: "invalid timestamp",
    },
    {
      name: "invalid date ordering",
      transitions: [
        transition(
          "end",
          listIds.working,
          listIds.review,
          "2026-08-30T10:00:00.000Z",
        ),
        transition(
          "start",
          listIds.ready,
          listIds.working,
          "2026-08-30T11:00:00.000Z",
        ),
      ],
      reason: "latest list transition",
    },
  ])("omits duration for $name", ({ transitions, reason }) => {
    const result = select(transitions);

    expect(result.pass).toBeNull();
    expect(result).toEqual(
      expect.objectContaining({ reason: expect.stringContaining(reason) }),
    );
  });

  it("omits duration when transition history is ambiguous", () => {
    const result = select([
      transition(
        "start-one",
        listIds.ready,
        listIds.working,
        "2026-08-30T10:00:00.000Z",
      ),
      transition(
        "start-two",
        listIds.review,
        listIds.working,
        "2026-08-30T10:00:00.000Z",
      ),
      transition(
        "end",
        listIds.working,
        listIds.review,
        "2026-08-30T11:00:00.000Z",
      ),
    ]);

    expect(result).toEqual({
      pass: null,
      reason: expect.stringContaining("ambiguous"),
    });
  });

  it("omits a retry duration when its Failed to Ready for Agent transition is missing", () => {
    const result = select([
      transition(
        "failed",
        listIds.working,
        listIds.failed,
        "2026-08-30T09:30:00.000Z",
      ),
      transition(
        "retry-start",
        listIds.ready,
        listIds.working,
        "2026-08-30T12:05:00.000Z",
      ),
      transition(
        "end",
        listIds.working,
        listIds.review,
        "2026-08-30T13:00:00.000Z",
      ),
    ]);

    expect(result.pass).toBeNull();
    expect(result).toEqual(
      expect.objectContaining({
        reason: expect.stringContaining("without a recorded transition"),
      }),
    );
  });

  it("omits a feedback duration when its Human Review to Working transition is missing", () => {
    const result = select([
      transition(
        "initial-start",
        listIds.ready,
        listIds.working,
        "2026-08-30T09:00:00.000Z",
      ),
      transition(
        "initial-end",
        listIds.working,
        listIds.review,
        "2026-08-30T10:00:00.000Z",
      ),
      transition(
        "feedback-end",
        listIds.working,
        listIds.review,
        "2026-08-31T09:07:05.000Z",
      ),
    ]);

    expect(result.pass).toBeNull();
    expect(result).toEqual(
      expect.objectContaining({
        reason: expect.stringContaining("selected working entry"),
      }),
    );
  });
});

describe("formatWorkflowDuration", () => {
  it.each([
    [0, "0 seconds"],
    [65_000, "1 minute 5 seconds"],
    [3_661_000, "1 hour 1 minute 1 second"],
    [90_061_000, "1 day 1 hour 1 minute 1 second"],
  ])("formats %d milliseconds as %s", (milliseconds, expected) => {
    expect(formatWorkflowDuration(milliseconds)).toBe(expected);
  });

  it("rejects a negative duration", () => {
    expect(() => formatWorkflowDuration(-1)).toThrow(
      "finite, non-negative number",
    );
  });
});
