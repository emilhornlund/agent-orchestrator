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
        projectId: project.id,
        cardId: "card",
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
      cardId: "card",
      incoming: [incoming],
      previous: [entry],
      worktreePath: "/tmp",
      openCode: new OpenCodeClient(run),
      signal: new AbortController().signal,
    });
    expect(result[0]?.requestRevision).toBe(changed ? 2 : 1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
    run.mockClear();
    await classifyCurrentFeedback({
      project,
      cardId: "card",
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
        cardId: "card",
        incoming: [entry],
        previous: [],
        worktreePath: "/tmp",
        signal: new AbortController().signal,
        openCode: new OpenCodeClient(async () => ({
          exitCode: 0,
          errorOutput: "",
          output: JSON.stringify({
            version: 1,
            projectId: project.id,
            cardId: "card",
            assessments,
          }),
        })),
      }),
    ).rejects.toThrow("does not match");
  },
);
