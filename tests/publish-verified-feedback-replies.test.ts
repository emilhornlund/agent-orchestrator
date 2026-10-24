import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import type { CiCheckEvaluation } from "../src/github/evaluate-ci-checks.js";
import { FeedbackLedgerStore } from "../src/task-session/feedback-ledger-store.js";
import { publishVerifiedFeedbackReplies } from "../src/task-session/publish-verified-feedback-replies.js";
import type { FeedbackVerificationResult } from "../src/task-session/feedback-verification.js";

let root: string;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-replies-"));
  const project = {
    id: "project",
    repository: {
      path: path.join(root, "repo"),
      worktreeRoot: path.join(root, "worktrees"),
    },
  } as ProjectConfig;
  fs.mkdirSync(project.repository.path, { recursive: true });
  const store = new FeedbackLedgerStore(path.join(root, "state"), project);
  store.create("card", [
    {
      kind: "inline-comment",
      id: "77",
      author: "reviewer",
      createdAt: "2026-10-24T09:00:00.000Z",
      updatedAt: null,
      body: "Fix the edge case.",
      threadId: "PRRT_thread",
      actionability: "actionable",
      status: "pending",
      verificationEvidence: [],
    },
  ]);
  const head = "a".repeat(40);
  const ciEvaluation: CiCheckEvaluation = {
    status: "passed",
    expectedHeadSha: head,
    expectedCheckNames: ["Build"],
  };
  const verification: FeedbackVerificationResult = {
    version: 1,
    projectId: "project",
    cardId: "card",
    headSha: head,
    contentIdentity: `sha256:${"b".repeat(64)}`,
    dispositions: [
      {
        feedbackId: "inline-comment:77",
        status: "verified-fixed",
        evidence: ["src/fix.ts", "tests/fix.test.ts"],
      },
    ],
  };
  const base = {
    project,
    cardId: "card",
    pullRequestUrl: "https://github.com/o/r/pull/1",
    publishedCommitSha: head,
    observedHeadSha: head,
    ciEvaluation,
    verification,
    ledgerStore: store,
  };
  return { base, store, head };
}

describe("publishVerifiedFeedbackReplies", () => {
  it("publishes only verified replies after all exact-head CI checks pass and persists reply IDs", async () => {
    const f = fixture();
    const reconcileReply = vi.fn(async () => ({ status: "absent" as const }));
    const sendReply = vi.fn(async (_entry, body: string, marker: string) => {
      expect(body).toContain(`Verified in published commit ${f.head}`);
      expect(body).toContain("tests/fix.test.ts");
      expect(body).toContain(marker);
      return "900";
    });
    const result = await publishVerifiedFeedbackReplies({
      ...f.base,
      reconcileReply,
      sendReply,
    });
    expect(result.publishedReplyIds).toEqual([
      { feedbackId: "inline-comment:77", replyId: "900" },
    ]);
    expect(f.store.read("card")?.entries[0]).toMatchObject({
      status: "published",
      replyId: "900",
      replyState: "sent",
      remediationCommitSha: f.head,
    });
    await publishVerifiedFeedbackReplies({
      ...f.base,
      reconcileReply,
      sendReply,
    });
    expect(sendReply).toHaveBeenCalledOnce();
  });

  it("does not send replies before CI succeeds on the published head", async () => {
    const f = fixture();
    const sendReply = vi.fn();
    await expect(
      publishVerifiedFeedbackReplies({
        ...f.base,
        ciEvaluation: {
          status: "waiting",
          expectedHeadSha: f.head,
          missingChecks: [],
          pendingChecks: ["Build"],
          diagnostic: "Build is pending",
        },
        reconcileReply: async () => ({ status: "absent" }),
        sendReply,
      }),
    ).rejects.toThrow("Complete current-head CI evidence has not passed");
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("reconciles an uncertain send by marker instead of duplicating the reply", async () => {
    const f = fixture();
    const sendReply = vi.fn(async () => {
      throw new Error("socket closed after request");
    });
    const reconcileReply = vi
      .fn()
      .mockResolvedValueOnce({ status: "absent" as const })
      .mockResolvedValueOnce({ status: "found" as const, replyId: "901" });
    await expect(
      publishVerifiedFeedbackReplies({ ...f.base, reconcileReply, sendReply }),
    ).rejects.toThrow("outcome is uncertain");
    expect(f.store.read("card")?.entries[0]?.replyState).toBe(
      "outcome-unknown",
    );
    const replay = await publishVerifiedFeedbackReplies({
      ...f.base,
      reconcileReply,
      sendReply,
    });
    expect(replay.publishedReplyIds).toEqual([
      { feedbackId: "inline-comment:77", replyId: "901" },
    ]);
    expect(sendReply).toHaveBeenCalledOnce();
  });
});
