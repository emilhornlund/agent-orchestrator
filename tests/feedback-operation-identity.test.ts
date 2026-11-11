import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { feedbackOperationId } from "../src/orchestrator/run-task-session-feedback-cycle.js";
import type { FeedbackLedgerEntry } from "../src/task-session/feedback-ledger.js";

const entry: FeedbackLedgerEntry = {
  kind: "inline-comment",
  id: "1",
  author: "human",
  body: "Fix this case",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: null,
  actionability: "actionable",
  status: "pending",
  verificationEvidence: [],
};
it("preserves legacy operation identities while distinguishing substantive same-body source revisions", () => {
  const head = "a".repeat(40);
  expect(feedbackOperationId(head, [entry])).toBe(
    `feedback:${head}:${createHash("sha256").update("inline-comment:1:Fix this case").digest("hex").slice(0, 16)}`,
  );
  const first = {
    ...entry,
    requestRevision: 1,
    sourceRevision: "b".repeat(64),
  };
  const changed = {
    ...first,
    requestRevision: 2,
    sourceRevision: "c".repeat(64),
  };
  expect(feedbackOperationId(head, [first])).not.toBe(
    feedbackOperationId(head, [changed]),
  );
  expect(
    feedbackOperationId(head, [
      { ...first, updatedAt: "2026-11-01T00:00:00.000Z" },
    ]),
  ).toBe(feedbackOperationId(head, [first]));
});
