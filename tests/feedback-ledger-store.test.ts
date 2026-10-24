import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import {
  FeedbackLedgerConflictError,
  FeedbackLedgerStore,
} from "../src/task-session/feedback-ledger-store.js";
import type { FeedbackLedgerEntry } from "../src/task-session/feedback-ledger.js";

let root: string;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-ledger-"));
  const project = {
    id: "project",
    repository: {
      path: path.join(root, "repo"),
      worktreeRoot: path.join(root, "worktrees"),
    },
  } as ProjectConfig;
  fs.mkdirSync(project.repository.path, { recursive: true });
  return { store: new FeedbackLedgerStore(path.join(root, "state"), project) };
}
const entry = (id: string, body = "Please fix this"): FeedbackLedgerEntry => ({
  kind: "inline-comment",
  id,
  author: "reviewer",
  createdAt: "2026-10-24T09:00:00.000Z",
  updatedAt: null,
  body,
  actionability: "unclassified",
  status: "pending",
  verificationEvidence: [],
});

describe("FeedbackLedgerStore", () => {
  it("merges and deduplicates new feedback while retaining earlier unresolved records", () => {
    const { store } = fixture();
    const first = store.mergeIncoming("card", [entry("comment-1")]);
    const updated = store.compareAndSwap("card", 1, {
      ...first,
      revision: 2,
      entries: [{ ...first.entries[0]!, actionability: "actionable" }],
    });
    const merged = store.mergeIncoming("card", [
      entry("comment-1", "Edited text"),
      entry("comment-2"),
    ]);
    expect(merged.revision).toBe(3);
    expect(merged.entries).toHaveLength(2);
    expect(merged.entries[0]).toMatchObject({
      body: "Edited text",
      actionability: "actionable",
      status: "pending",
    });
    expect(store.read("card")).toEqual(merged);
    const restarted = new FeedbackLedgerStore(path.join(root, "state"), {
      id: "project",
      repository: {
        path: path.join(root, "repo"),
        worktreeRoot: path.join(root, "worktrees"),
      },
    } as ProjectConfig);
    expect(restarted.read("card")).toEqual(merged);
    expect(updated.revision).toBe(2);
  });

  it("rejects stale writes, wrong-task access, and malformed persisted data", () => {
    const { store } = fixture();
    const ledger = store.create("card", [entry("id")]);
    expect(() =>
      store.compareAndSwap("card", 2, { ...ledger, revision: 3 }),
    ).toThrow(FeedbackLedgerConflictError);
    expect(() => store.read("other-card")).not.toThrow();
    const file = path.join(
      root,
      "state",
      "feedback-ledgers",
      "project",
      "card.json",
    );
    fs.writeFileSync(
      file,
      JSON.stringify({ ...ledger, cardId: "other-card" }),
      "utf8",
    );
    expect(() => store.read("card")).toThrow("ownership mismatch");
    fs.writeFileSync(file, "{broken", "utf8");
    expect(() => store.read("card")).toThrow("Could not parse feedback ledger");
  });

  it("rejects identity collisions and unsafe storage roots", () => {
    const { store } = fixture();
    expect(() => store.create("card", [entry("same"), entry("same")])).toThrow(
      "Duplicate feedback identity",
    );
  });
});
