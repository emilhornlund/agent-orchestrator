import { describe, expect, it } from "vitest";

import {
  parseTaskExecutionRecord,
  type TaskExecutionRecord,
} from "../src/task-session/task-execution-record.js";

const record: TaskExecutionRecord = {
  version: 1,
  projectId: "project-one",
  cardId: "card-one",
  phase: "human-feedback",
  primarySessionId: "session-one",
  expectedBranch: "agent/card-one",
  pullRequest: {
    number: 42,
    url: "https://github.com/owner/repository/pull/42",
    headSha: "a".repeat(40),
  },
  operationKey: "feedback-42-1",
  revision: 3,
  retryCounters: {
    validation: 1,
    review: 0,
    ci: 2,
    humanFeedback: 1,
  },
  createdAt: "2026-10-24T09:00:00.000Z",
  updatedAt: "2026-10-24T09:05:00.000Z",
};

describe("parseTaskExecutionRecord", () => {
  it("round-trips a valid versioned record through JSON", () => {
    const decoded = JSON.parse(JSON.stringify(record)) as unknown;

    expect(parseTaskExecutionRecord(decoded)).toEqual(record);
  });

  it.each([
    ["empty project ID", { projectId: "" }],
    ["padded card ID", { cardId: " card-one" }],
    ["path traversal card ID", { cardId: "../card-one" }],
    ["empty operation key", { operationKey: " " }],
  ])("rejects a malformed %s", (_description, update) => {
    expect(() => parseTaskExecutionRecord({ ...record, ...update })).toThrow();
  });

  it("rejects an unknown record version", () => {
    expect(() => parseTaskExecutionRecord({ ...record, version: 2 })).toThrow();
  });

  it("rejects an invalid phase", () => {
    expect(() =>
      parseTaskExecutionRecord({ ...record, phase: "queued" }),
    ).toThrow();
  });

  it.each([
    [
      "implementation without its primary session",
      { primarySessionId: undefined, phase: "implementation" },
    ],
    [
      "implementation without its branch",
      { expectedBranch: undefined, phase: "implementation" },
    ],
    ["CI without its pull request", { pullRequest: undefined, phase: "ci" }],
  ])("rejects an impossible state: %s", (_description, update) => {
    expect(() => parseTaskExecutionRecord({ ...record, ...update })).toThrow();
  });

  it("rejects negative retry counters and backward timestamps", () => {
    expect(() =>
      parseTaskExecutionRecord({
        ...record,
        retryCounters: { ...record.retryCounters, ci: -1 },
      }),
    ).toThrow();
    expect(() =>
      parseTaskExecutionRecord({
        ...record,
        updatedAt: "2026-10-24T08:59:59.000Z",
      }),
    ).toThrow();
  });
});
