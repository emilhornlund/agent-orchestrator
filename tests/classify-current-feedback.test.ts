import { expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import {
  classifyCurrentFeedback,
  feedbackSourceRevision,
} from "../src/task-session/classify-current-feedback.js";
import type { FeedbackLedgerEntry } from "../src/task-session/feedback-ledger.js";

const entry: FeedbackLedgerEntry = {
  kind: "conversation-comment",
  id: "1",
  author: "human",
  body: "Fix the edge case",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: null,
  actionability: "actionable",
  status: "escalated",
  unresolvedReason: "Not fixed",
  verificationEvidence: [],
  requestRevision: 1,
};
const project = {
  id: "project",
  opencode: { review: {}, timeoutMinutes: 1 },
} as ProjectConfig;

it("applies a same-author withdrawal only to the linked review revision", async () => {
  const pullRequestUrl = "https://github.com/owner/repo/pull/772";
  const request = { ...entry, kind: "review" as const, sourceRevision: undefined };
  const unrelated = { ...request, id: "2", author: "other" };
  const withdrawal = {
    ...request,
    id: "3",
    body: `I withdraw the request in my prior review (${pullRequestUrl}#pullrequestreview-1).`,
    createdAt: "2026-10-02T00:00:00.000Z",
  };
  const run = vi.fn(async () => ({
    exitCode: 0,
    errorOutput: "",
    output: JSON.stringify({
      version: 1,
      assessments: [
        {
          feedbackId: "review:3",
          sourceRevision: feedbackSourceRevision(withdrawal),
          actionability: "discussion",
          substantiveChange: false,
          supersededFeedbackIds: ["review:1"],
        },
      ],
    }),
  }));
  const options = {
    project,
    pullRequestUrl,
    worktreePath: "/tmp",
    signal: new AbortController().signal,
    openCode: new OpenCodeClient(run),
  };
  const incoming = [request, unrelated, withdrawal];
  const current = await classifyCurrentFeedback({
    ...options,
    incoming,
    previous: [request, unrelated],
  });
  expect(current.map(({ id }) => id)).toEqual(["2", "3"]);
  const refreshed = await classifyCurrentFeedback({
    ...options,
    incoming,
    previous: [request, ...current],
  });
  expect(refreshed.map(({ id }) => id)).toEqual(["2", "3"]);
  expect(refreshed[1]?.supersedes).toEqual(current[1]?.supersedes);
  expect(run).toHaveBeenCalledTimes(1);
  expect(
    (
      await classifyCurrentFeedback({
        ...options,
        incoming: [request, unrelated],
        previous: [request, ...current],
      })
    ).map(({ id }) => id),
  ).toEqual(["1", "2"]);
});
it.each([false, true])(
  "validates substantive-change judgment (%s) without using timestamps or heads as new requests",
  async (changed) => {
    const incoming = {
      ...entry,
      body: "Fix the other edge case",
      status: "pending" as const,
      updatedAt: "2026-11-01T00:00:00.000Z",
    };
    const run = vi.fn(async () => ({
      exitCode: 0,
      errorOutput: "",
      output: JSON.stringify({
        version: 1,
        assessments: [
          {
            feedbackId: "conversation-comment:1",
            sourceRevision: feedbackSourceRevision(incoming),
            actionability: "actionable",
            substantiveChange: changed,
          },
        ],
      }),
    }));
    const result = await classifyCurrentFeedback({
      project,
      incoming: [incoming],
      previous: [entry],
      worktreePath: "/tmp",
      openCode: new OpenCodeClient(run),
      signal: new AbortController().signal,
    });
    expect(result[0]?.requestRevision).toBe(changed ? 2 : 1);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true, prompt: expect.not.stringContaining('"cardId"') }),
    );
    run.mockClear();
    await classifyCurrentFeedback({
      project,
      incoming: result.map((item) => ({
        ...item,
        headSha: "b".repeat(40),
        updatedAt: "2026-11-02T00:00:00.000Z",
      })),
      previous: result,
      worktreePath: "/tmp",
      openCode: new OpenCodeClient(run),
      signal: new AbortController().signal,
    });
    expect(run).not.toHaveBeenCalled();
  },
);

it.each(["wrong-source", "missing", "duplicate", "invented"])(
  "rejects %s classification rather than changing the ledger",
  async (fault) => {
    const assessment = {
      feedbackId: "conversation-comment:1",
      sourceRevision: feedbackSourceRevision(entry),
      actionability: "actionable",
      substantiveChange: true,
    };
    const assessments =
      fault === "missing"
        ? []
        : fault === "duplicate"
          ? [assessment, assessment]
          : [
              {
                ...assessment,
                ...(fault === "wrong-source"
                  ? { sourceRevision: "wrong" }
                  : { feedbackId: "invented" }),
              },
            ];
    await expect(
      classifyCurrentFeedback({
        project,
        incoming: [entry],
        previous: [],
        worktreePath: "/tmp",
        signal: new AbortController().signal,
        openCode: new OpenCodeClient(async () => ({
          exitCode: 0,
          errorOutput: "",
          output: JSON.stringify({
            version: 1,
            assessments,
          }),
        })),
      }),
    ).rejects.toThrow("does not match");
  },
);

it("recovers once from the observed combined actionability token without weakening source validation", async () => {
  const run = vi.fn(async () => ({
    exitCode: 0,
    errorOutput: "",
    output: JSON.stringify({
      version: 1,
      assessments: [
        {
          feedbackId: "conversation-comment:1",
          sourceRevision: feedbackSourceRevision(entry),
          actionability: run.mock.calls.length === 1 ? "discussion/not-actionable" : "discussion",
          substantiveChange: false,
        },
      ],
    }),
  }));
  const result = await classifyCurrentFeedback({
    project,
    incoming: [entry],
    previous: [],
    worktreePath: "/tmp",
    signal: new AbortController().signal,
    openCode: new OpenCodeClient(run),
  });
  expect(run).toHaveBeenCalledTimes(2);
  expect(run).toHaveBeenLastCalledWith(
    expect.objectContaining({ prompt: expect.stringContaining('"discussion", "not-actionable"') }),
  );
  expect(result[0]?.actionability).toBe("discussion");
});
