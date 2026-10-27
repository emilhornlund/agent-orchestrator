import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import {
  TaskMutationQueue,
  TaskMutationQueueConflictError,
} from "../src/task-session/task-mutation-queue.js";

let root: string | undefined;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});
function queueFor(projectId: string) {
  root ??= fs.mkdtempSync(path.join(os.tmpdir(), "mutation-queue-"));
  const workspace = root;
  const project = {
    id: projectId,
    repository: {
      path: path.join(workspace, `repo-${projectId}`),
      worktreeRoot: path.join(workspace, `worktrees-${projectId}`),
    },
  } as ProjectConfig;
  fs.mkdirSync(project.repository.path, { recursive: true });
  fs.mkdirSync(project.repository.worktreeRoot, { recursive: true });
  return new TaskMutationQueue(path.join(workspace, "state"), project);
}
const task = (
  projectId: string,
  eventId: string,
  cardId: string,
  enqueuedAt: string,
) => ({
  projectId,
  eventId,
  cardId,
  kind: "feedback" as const,
  operationKey: `operation-${eventId}`,
  enqueuedAt,
});

const legacyProductionRetirements = [
  "implementation:6ae0de2c9698c39d9aef39ac:e84ba7c9750946cc",
  "implementation:6ae0de42841dfb17c4586fe1:45fca18677b6e871",
  "implementation:6ae0de5b6f5885c6419e39ac:5e78d1e5064fbb2a",
  "implementation:6ae0de73cd9aede357ddfd12:852c641926d7175e",
  "implementation:6ae0de8b86f104140d006d5e:9cc9065ae2ae1b7a",
];

describe("TaskMutationQueue", () => {
  it("deduplicates events and claims at most one deterministic project mutation", () => {
    const queue = queueFor("project-a");
    queue.enqueue(
      task("project-a", "later", "card-b", "2026-10-24T09:02:00.000Z"),
    );
    queue.enqueue(
      task("project-a", "earlier", "card-a", "2026-10-24T09:01:00.000Z"),
    );
    expect(
      queue.enqueue(
        task("project-a", "earlier", "card-a", "2026-10-24T09:03:00.000Z"),
      ).status,
    ).toBe("queued");
    expect(queue.claimNext()?.eventId).toBe("earlier");
    expect(queue.claimNext()).toBeNull();
    queue.complete("earlier");
    expect(queue.claimNext()?.eventId).toBe("later");
  });

  it("persists active ownership across restart and does not silently release failures", () => {
    const queue = queueFor("project-a");
    queue.enqueue(
      task("project-a", "one", "card-one", "2026-10-24T09:00:00.000Z"),
    );
    queue.enqueue(
      task("project-a", "two", "card-two", "2026-10-24T09:01:00.000Z"),
    );
    queue.claimNext();
    queue.fail("one");
    const restarted = queueFor("project-a");
    expect(restarted.getActive()?.eventId).toBe("one");
    expect(restarted.claimNext()).toBeNull();
    expect(() => restarted.complete("two")).toThrow(
      TaskMutationQueueConflictError,
    );
    restarted.requeueAfterVerifiedRecovery("one");
    expect(restarted.claimNext()?.eventId).toBe("one");
  });

  it("reclaims the verified recovery event ahead of queued work", () => {
    const queue = queueFor("project-a");
    queue.enqueue(
      task("project-a", "first", "card-one", "2026-10-24T09:01:00.000Z"),
    );
    queue.claimNext();
    queue.enqueue(
      task("project-a", "second", "card-two", "2026-10-24T09:00:00.000Z"),
    );
    queue.fail("first");

    const restarted = queueFor("project-a");
    expect(restarted.claimForRecovery("first")).toMatchObject({
      eventId: "first",
      status: "active",
    });
    expect(restarted.getActive()?.eventId).toBe("first");
    expect(restarted.claimNext()).toBeNull();
    restarted.complete("first");
    expect(restarted.claimNext()?.eventId).toBe("second");
  });

  it("reclaims a released completed-task owner from a fresh queue instance", () => {
    const queue = queueFor("project-a");
    queue.enqueue(
      task(
        "project-a",
        "complete-after-restart",
        "card-one",
        "2026-10-24T09:00:00.000Z",
      ),
    );
    queue.claimNext();
    queue.releaseForRecovery("complete-after-restart");

    const restarted = queueFor("project-a");
    expect(restarted.claimForRecovery("complete-after-restart")).toMatchObject({
      eventId: "complete-after-restart",
      status: "active",
    });
    expect(restarted.getActive()?.ownerToken).toBeDefined();
    restarted.complete("complete-after-restart");
    expect(restarted.list()[0]?.status).toBe("completed");
  });

  it("does not steal a different active event during restart recovery", () => {
    const queue = queueFor("project-a");
    queue.enqueue(
      task("project-a", "first", "card-one", "2026-10-24T09:00:00.000Z"),
    );
    queue.enqueue(
      task("project-a", "second", "card-two", "2026-10-24T09:01:00.000Z"),
    );
    queue.claimNext();

    expect(queue.claimForRecovery("second")).toBeNull();
    expect(queue.getActive()?.eventId).toBe("first");
  });

  it("prevents a second polling owner from resuming the same active mutation", () => {
    const owner = queueFor("project-a");
    owner.enqueue(
      task("project-a", "active", "card-one", "2026-10-24T09:00:00.000Z"),
    );
    expect(owner.claimNext()?.status).toBe("active");
    expect(owner.ownsActive("active")).toBe(true);

    const contender = queueFor("project-a");
    expect(contender.claimForRecovery("active")).toBeNull();
    expect(contender.ownsActive("active")).toBe(false);
    expect(() => contender.fail("active")).toThrow(
      TaskMutationQueueConflictError,
    );
    expect(owner.getActive()?.status).toBe("active");
  });

  it("reclaims a persisted active event only after its process owner is gone", () => {
    const queue = queueFor("project-a");
    queue.enqueue(
      task("project-a", "orphaned", "card-one", "2026-10-24T09:00:00.000Z"),
    );
    const statePath = path.join(
      root!,
      "state",
      "task-mutation-queues",
      "project-a.json",
    );
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      activeEventId: string | null;
      events: Array<{
        eventId: string;
        status: string;
        ownerToken?: string;
        ownerPid?: number;
      }>;
    };
    persisted.activeEventId = "orphaned";
    persisted.events[0]!.status = "active";
    persisted.events[0]!.ownerToken = "00000000-0000-4000-8000-000000000001";
    persisted.events[0]!.ownerPid = 2_147_483_647;
    fs.writeFileSync(statePath, JSON.stringify(persisted), "utf8");

    const restarted = queueFor("project-a");
    expect(restarted.claimForRecovery("orphaned")).toMatchObject({
      eventId: "orphaned",
      status: "active",
    });
    expect(restarted.ownsActive("orphaned")).toBe(true);
  });

  it("reclaims a stale owner whose PID was reused by the restarted process", () => {
    const original = queueFor("project-a");
    original.enqueue(
      task("project-a", "reused-pid", "card-one", "2026-10-24T09:00:00.000Z"),
    );
    original.claimNext();

    const statePath = path.join(
      root!,
      "state",
      "task-mutation-queues",
      "project-a.json",
    );
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      events: Array<{
        ownerToken?: string;
        ownerPid?: number;
      }>;
    };
    // Model a prior container instance that owned PID 1. The new process has
    // the same PID but cannot have the old owner's in-memory token.
    persisted.events[0]!.ownerToken = "00000000-0000-4000-8000-000000000002";
    persisted.events[0]!.ownerPid = process.pid;
    fs.writeFileSync(statePath, JSON.stringify(persisted), "utf8");

    const restarted = queueFor("project-a");
    expect(restarted.claimForRecovery("reused-pid")).toMatchObject({
      eventId: "reused-pid",
      status: "active",
    });
    expect(restarted.ownsActive("reused-pid")).toBe(true);
    restarted.complete("reused-pid");
    expect(restarted.getActive()).toBeNull();
  });

  it("keeps independent project queues isolated and rejects reused event identities", () => {
    const first = queueFor("project-a");
    const second = queueFor("project-b");
    first.enqueue(
      task("project-a", "same", "card-a", "2026-10-24T09:00:00.000Z"),
    );
    second.enqueue(
      task("project-b", "same", "card-b", "2026-10-24T09:00:00.000Z"),
    );
    expect(first.claimNext()?.cardId).toBe("card-a");
    expect(second.claimNext()?.cardId).toBe("card-b");
    expect(() =>
      first.enqueue(
        task("project-a", "same", "other-card", "2026-10-24T09:00:00.000Z"),
      ),
    ).toThrow("reused");
  });

  it("retires a verified orphaned Ready claim so terminal cleanup can proceed", () => {
    const queue = queueFor("project-a");
    queue.enqueue({
      ...task("project-a", "stale", "moved-card", "2026-10-24T09:00:00.000Z"),
      kind: "implementation",
    });
    queue.claimNext();
    expect(queue.getActive()?.eventId).toBe("stale");
    expect(queue.retireOrphanedReadyEvent("stale").status).toBe("retired");
    expect(queue.getActive()).toBeNull();
    queue.enqueue({
      ...task(
        "project-a",
        "terminal",
        "merged-card",
        "2026-10-24T09:01:00.000Z",
      ),
      kind: "terminal-pr",
    });
    expect(queue.claimForRecovery("terminal")?.eventId).toBe("terminal");
    queue.complete("terminal");
  });

  it("retires queued orphan events without disturbing another active owner", () => {
    const queue = queueFor("project-a");
    queue.enqueue({
      ...task(
        "project-a",
        "current",
        "current-card",
        "2026-10-24T09:00:00.000Z",
      ),
      kind: "implementation",
    });
    queue.claimNext();
    queue.enqueue({
      ...task(
        "project-a",
        "orphan",
        "removed-card",
        "2026-10-24T09:01:00.000Z",
      ),
      kind: "implementation",
    });
    expect(queue.retireOrphanedReadyEvent("orphan").status).toBe("retired");
    expect(queue.getActive()?.eventId).toBe("current");
    expect(() => queue.retireOrphanedReadyEvent("current")).not.toThrow();
    expect(queue.getActive()).toBeNull();
    expect(() => queue.retireOrphanedReadyEvent("orphan")).toThrow(
      TaskMutationQueueConflictError,
    );
  });

  it("does not retire failed mutations requiring explicit recovery", () => {
    const queue = queueFor("project-a");
    queue.enqueue({
      ...task("project-a", "failed", "card-one", "2026-10-24T09:00:00.000Z"),
      kind: "implementation",
    });
    queue.claimNext();
    queue.fail("failed");
    expect(() => queue.retireOrphanedReadyEvent("failed")).toThrow(
      TaskMutationQueueConflictError,
    );
    expect(queue.getActive()?.eventId).toBe("failed");
  });

  it("preserves retired history as distinct from successful completion across restart", () => {
    const queue = queueFor("project-a");
    queue.enqueue({
      ...task("project-a", "retire-me", "card-one", "2026-10-24T09:00:00.000Z"),
      kind: "implementation",
    });
    queue.retireOrphanedReadyEvent("retire-me");

    const restarted = queueFor("project-a");
    expect(restarted.list()).toMatchObject([
      { eventId: "retire-me", status: "retired" },
    ]);
    expect(restarted.claimNext()).toBeNull();
    expect(() => restarted.complete("retire-me")).toThrow(
      TaskMutationQueueConflictError,
    );
  });

  it("preserves legacy completed production identities without assuming retirement", () => {
    const queue = queueFor("project-a");
    for (const [index, eventId] of legacyProductionRetirements.entries()) {
      const cardId = eventId.split(":")[1]!;
      queue.enqueue({
        projectId: "project-a",
        cardId,
        eventId,
        operationKey: `task-session:${cardId}:${eventId.split(":")[2]}`,
        kind: "implementation",
        enqueuedAt: new Date(
          Date.parse("2026-10-27T00:00:00.000Z") + index,
        ).toISOString(),
      });
      queue.claimNext();
      queue.complete(eventId);
    }
    const restarted = queueFor("project-a");
    expect(restarted.list().map((event) => event.eventId)).toEqual(
      legacyProductionRetirements,
    );
    expect(
      restarted.list().every((event) => event.status === "completed"),
    ).toBe(true);
  });

  it("requires an explicit attestation and an unowned queue to recover legacy completion", () => {
    const queue = queueFor("project-a");
    queue.enqueue({
      ...task(
        "project-a",
        "legacy-completed",
        "card-one",
        "2026-10-24T09:00:00.000Z",
      ),
      kind: "implementation",
    });
    queue.claimNext();
    queue.complete("legacy-completed");
    expect(() =>
      queue.retireLegacyCompletedEvent("legacy-completed", false),
    ).toThrow(TaskMutationQueueConflictError);
    expect(
      queue.retireLegacyCompletedEvent("legacy-completed", true),
    ).toMatchObject({
      status: "retired",
      retirementReason: "operator-confirmed-never-started",
    });
  });
});
