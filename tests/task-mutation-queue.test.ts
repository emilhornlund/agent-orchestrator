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
        task("project-a", "earlier", "card-a", "2026-10-24T09:01:00.000Z"),
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
});
