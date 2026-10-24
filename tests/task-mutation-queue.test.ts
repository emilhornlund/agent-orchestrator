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
