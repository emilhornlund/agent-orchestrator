import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import { FeedbackLedgerStore } from "../src/task-session/feedback-ledger-store.js";
import type { FeedbackLedgerEntry } from "../src/task-session/feedback-ledger.js";
import { reconcileFeedbackRound } from "../src/task-session/reconcile-feedback-round.js";

let root: string;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-round-"));
  const project = {
    id: "p",
    repository: {
      path: path.join(root, "repo"),
      worktreeRoot: path.join(root, "worktrees"),
    },
  } as ProjectConfig;
  fs.mkdirSync(project.repository.path, { recursive: true });
  const store = new FeedbackLedgerStore(path.join(root, "state"), project);
  return { store, sha: "a".repeat(40) };
}
const entry = (
  id: string,
  overrides: Partial<FeedbackLedgerEntry> = {},
): FeedbackLedgerEntry => ({
  kind: "inline-comment",
  id,
  author: "reviewer",
  createdAt: "2026-10-24T09:00:00.000Z",
  updatedAt: null,
  body: `Fix ${id}`,
  actionability: "actionable",
  status: "pending",
  verificationEvidence: [],
  isResolved: false,
  isOutdated: false,
  ...overrides,
});

describe("reconcileFeedbackRound", () => {
  it("carries earlier unresolved feedback and adds a late actionable item", () => {
    const f = fixture();
    f.store.create("card", [entry("old")]);
    const result = reconcileFeedbackRound({
      store: f.store,
      projectId: "p",
      cardId: "card",
      previousHeadSha: f.sha,
      observedHeadSha: f.sha,
      newlyObservedFeedback: [entry("old"), entry("late")],
    });
    expect(result.ledger.entries.map(({ id }) => id)).toEqual(["old", "late"]);
    expect(result.newActionableFeedbackIds).toEqual(["inline-comment:late"]);
    expect(result.feedbackChanged).toBe(true);
    expect(result.evidenceStillValid).toBe(false);
  });

  it("invalidates evidence on a new head and avoids duplicate work on an unchanged round", () => {
    const f = fixture();
    f.store.create("card", [entry("old")]);
    const unchanged = reconcileFeedbackRound({
      store: f.store,
      projectId: "p",
      cardId: "card",
      previousHeadSha: f.sha,
      observedHeadSha: f.sha,
      newlyObservedFeedback: [entry("old")],
    });
    expect(unchanged.evidenceStillValid).toBe(true);
    expect(unchanged.noNewActionableFeedback).toBe(true);
    const nextHead = reconcileFeedbackRound({
      store: f.store,
      projectId: "p",
      cardId: "card",
      previousHeadSha: f.sha,
      observedHeadSha: "b".repeat(40),
      newlyObservedFeedback: [entry("old")],
    });
    expect(nextHead.headChanged).toBe(true);
    expect(nextHead.evidenceStillValid).toBe(false);
    expect(nextHead.noNewActionableFeedback).toBe(true);
  });

  it("closes feedback GitHub marks resolved or outdated", () => {
    const f = fixture();
    f.store.create("card", [entry("old")]);
    const result = reconcileFeedbackRound({
      store: f.store,
      projectId: "p",
      cardId: "card",
      previousHeadSha: f.sha,
      observedHeadSha: f.sha,
      newlyObservedFeedback: [entry("old", { isResolved: true })],
    });
    expect(result.ledger.entries[0]).toMatchObject({
      actionability: "not-actionable",
      status: "closed",
    });
    expect(result.remainingActionableFeedbackIds).toEqual([]);
  });
});
