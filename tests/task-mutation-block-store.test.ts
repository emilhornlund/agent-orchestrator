import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskMutationBlockStore } from "../src/orchestrator/task-mutation-block-store.js";

let root: string | undefined;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("TaskMutationBlockStore", () => {
  it("deduplicates multiple independent blockers across restart and resolves them separately", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mutation-block-store-"));
    const first = new TaskMutationBlockStore(root, "project");
    expect(
      first.report("event-a", "event-a|active", "blocked by event-a"),
    ).toBe(true);
    expect(
      first.report("event-b", "event-b|failed", "blocked by event-b"),
    ).toBe(true);
    expect(
      first.report("event-a", "event-a|active", "blocked by event-a"),
    ).toBe(false);

    const restarted = new TaskMutationBlockStore(root, "project");
    expect(
      restarted.report("event-a", "event-a|active", "blocked by event-a"),
    ).toBe(false);
    expect(
      restarted.report("event-b", "event-b|failed", "blocked by event-b"),
    ).toBe(false);

    restarted.resolve("event-a");
    expect(
      first.report("event-b", "event-b|failed", "blocked by event-b"),
    ).toBe(false);
    expect(
      first.report("event-a", "event-a|active", "blocked by event-a again"),
    ).toBe(true);
    expect(
      restarted.report("event-a", "event-a|active", "blocked by event-a"),
    ).toBe(false);

    first.resolve("event-b");
    expect(
      restarted.report("event-a", "event-a|active", "blocked by event-a"),
    ).toBe(false);
    restarted.resolve("event-a");
    expect(
      first.report("event-a", "event-a|active", "blocked by event-a recurred"),
    ).toBe(true);
  });

  it("reports a materially changed identity for the same blocker scope", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mutation-block-store-"));
    const store = new TaskMutationBlockStore(root, "project");
    expect(store.report("event-a", "active", "active blocker")).toBe(true);
    expect(store.report("event-a", "active", "active blocker unchanged")).toBe(
      false,
    );
    expect(store.report("event-a", "failed", "failed blocker")).toBe(true);
  });
});
