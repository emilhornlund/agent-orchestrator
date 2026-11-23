import { expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import {
  OpenCodeClient,
  OpenCodeDefaultProviderResolutionError,
  OpenCodeRunAbortedError,
  OpenCodeTimeoutError,
  type RunOpenCode,
} from "../src/opencode/opencode-client.js";
import {
  classifyCurrentFeedback,
  feedbackSourceRevision,
} from "../src/task-session/classify-current-feedback.js";
import type { FeedbackLedgerEntry } from "../src/task-session/feedback-ledger.js";
import { AiCapacityCancelledError } from "../src/orchestrator/ai-execution-capacity.js";

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

const executionId = "5125c222-01d9-4937-af6d-2a72e6a2c040";
it("returns a blocked wait without launching a classifier when every revision is withheld", async () => {
  const run = vi.fn<RunOpenCode>();
  const waiting = {
    status: "blocked" as const,
    retryAt: "2026-11-23T19:00:00.000Z",
    reason: "Dependency probe required",
  };
  const result = await classifyCurrentFeedback({
    project,
    incoming: [entry],
    previous: [],
    worktreePath: "/tmp",
    openCode: new OpenCodeClient(run),
    signal: new AbortController().signal,
    selectRevisions: () => waiting,
  });
  expect(result).toEqual(waiting);
  expect(run).not.toHaveBeenCalled();
});

it("preserves a task-wide stop blocker even with an unchanged classified pending request", async () => {
  const pending = { ...entry, status: "pending" as const };
  const run = vi.fn<RunOpenCode>();
  const wait = {
    status: "blocked" as const,
    taskWide: true as const,
    retryAt: null,
    reason: "Unknown process termination",
  };
  const selection = vi.fn(() => wait);
  expect(
    await classifyCurrentFeedback({
      project,
      incoming: [pending],
      previous: [pending],
      worktreePath: "/tmp",
      openCode: new OpenCodeClient(run),
      signal: new AbortController().signal,
      selectRevisions: selection,
    }),
  ).toEqual(wait);
  expect(selection).toHaveBeenCalledWith([]);
  expect(run).not.toHaveBeenCalled();
});
it("compares a deferred edit against the prior classified revision", async () => {
  const edited = {
    ...entry,
    body: "Fix a different condition",
    actionability: "unclassified" as const,
  };
  const run = vi.fn<RunOpenCode>(async ({ prompt }) => {
    expect(prompt).toContain(entry.body);
    return {
      exitCode: 0,
      errorOutput: "",
      output: JSON.stringify({
        version: 1,
        assessments: [
          {
            feedbackId: "conversation-comment:1",
            sourceRevision: feedbackSourceRevision(edited),
            actionability: "actionable",
            substantiveChange: true,
          },
        ],
      }),
    };
  });
  const result = await classifyCurrentFeedback({
    project,
    incoming: [edited],
    previous: [edited],
    history: [entry],
    worktreePath: "/tmp",
    openCode: new OpenCodeClient(run),
    signal: new AbortController().signal,
  });
  expect(result[0]).toMatchObject({ actionability: "actionable", requestRevision: 2 });
});
it("can reuse a verified pending request while another source remains unavailable", async () => {
  const verified = { ...entry, status: "pending" as const, unresolvedReason: undefined };
  const deferred = {
    ...entry,
    id: "2",
    actionability: "unclassified" as const,
    status: "pending" as const,
  };
  const run = vi.fn<RunOpenCode>();
  const result = await classifyCurrentFeedback({
    project,
    incoming: [verified, deferred],
    previous: [verified],
    worktreePath: "/tmp",
    openCode: new OpenCodeClient(run),
    signal: new AbortController().signal,
    selectRevisions: () => [],
  });
  expect(result).toMatchObject([
    { actionability: "actionable" },
    { actionability: "unclassified" },
  ]);
  expect(run).not.toHaveBeenCalled();
});

it.each<[string, RunOpenCode]>([
  [
    "nonzero",
    async () => ({
      exitCode: 7,
      errorOutput: "private child output",
      output: "",
      processExecutionId: executionId,
    }),
  ],
  [
    "provider-unavailable",
    async () => ({
      exitCode: 0,
      errorOutput: "",
      output: "",
      failureClassification: "dependency-outage",
    }),
  ],
  [
    "malformed",
    async () => ({
      exitCode: 0,
      errorOutput: "",
      output: "incomplete JSON",
      processExecutionId: executionId,
    }),
  ],
  [
    "cancelled",
    async () => {
      throw new OpenCodeRunAbortedError();
    },
  ],
  [
    "cancelled",
    async () => {
      throw new AiCapacityCancelledError();
    },
  ],
  [
    "timeout",
    async () => {
      throw new OpenCodeTimeoutError(200, executionId, true);
    },
  ],
  [
    "execution-uncertain",
    async () => {
      throw new OpenCodeTimeoutError(200, executionId);
    },
  ],
  [
    "configuration",
    async () => {
      throw new OpenCodeDefaultProviderResolutionError();
    },
  ],
])("returns a typed %s failure without applying a partial result", async (classification, run) => {
  const execute = vi.fn(run);
  await expect(
    classifyCurrentFeedback({
      project,
      incoming: [entry],
      previous: [],
      worktreePath: "/tmp",
      openCode: new OpenCodeClient(execute),
      signal: new AbortController().signal,
      singleExecution: true,
    }),
  ).rejects.toMatchObject({
    classification,
    ...(classification === "nonzero"
      ? { executionId, exitCode: 7, message: expect.not.stringContaining("private child output") }
      : {}),
  });
  expect(execute).toHaveBeenCalledTimes(1);
});
