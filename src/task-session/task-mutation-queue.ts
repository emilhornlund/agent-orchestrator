import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ProjectConfig } from "../config/config.js";

const eventSchema = z.strictObject({
  eventId: z
    .string()
    .min(1)
    .refine((value) => value.trim() === value),
  projectId: z.string().min(1),
  cardId: z.string().min(1),
  kind: z.enum([
    "implementation",
    "refinement",
    "terminal-pr",
    "ci-repair",
    "feedback",
    "pr-maintenance",
  ]),
  operationKey: z.string().min(1),
  enqueuedAt: z.string().datetime(),
  status: z.enum(["queued", "active", "failed", "completed", "retired"]),
  ownerToken: z.string().uuid().optional(),
  ownerPid: z.number().int().positive().optional(),
  retiredAt: z.string().datetime().optional(),
  retirementReason: z
    .enum(["card-left-ready", "operator-confirmed-never-started"])
    .optional(),
});
const queueSchema = z
  .strictObject({
    version: z.literal(1),
    projectId: z.string().min(1),
    revision: z.number().int().positive().safe(),
    activeEventId: z.string().nullable(),
    events: z.array(eventSchema).max(10_000),
  })
  .superRefine((queue, ctx) => {
    const ids = new Set<string>();
    const activeIds: string[] = [];
    for (const [index, event] of queue.events.entries()) {
      if (event.projectId !== queue.projectId) {
        ctx.addIssue({
          code: "custom",
          path: ["events", index, "projectId"],
          message: "Mutation event belongs to another project",
        });
      }
      if (
        (event.status === "retired") !==
        (event.retiredAt !== undefined && event.retirementReason !== undefined)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["events", index],
          message:
            "Retired mutations require a durable retirement time and reason",
        });
      }
      if (ids.has(event.eventId)) {
        ctx.addIssue({
          code: "custom",
          path: ["events", index, "eventId"],
          message: "Mutation event IDs must be unique",
        });
      }
      ids.add(event.eventId);
      if (event.status === "active" || event.status === "failed") {
        activeIds.push(event.eventId);
      }
    }
    if (
      activeIds.length > 1 ||
      (queue.activeEventId === null && activeIds.length !== 0) ||
      (queue.activeEventId !== null &&
        (activeIds.length !== 1 || activeIds[0] !== queue.activeEventId))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["activeEventId"],
        message: "Queue must preserve exactly one active mutation owner",
      });
    }
  });
export type TaskMutationEvent = z.infer<typeof eventSchema>;
type QueueRecord = z.infer<typeof queueSchema>;
const liveMutationOwners = new Set<string>();

function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  // A PID is only unique within the current process namespace lifetime. In
  // containers, a restarted Node process commonly reuses PID 1. If the owner
  // PID is ours but its token is not in liveMutationOwners, it belongs to an
  // earlier process instance and is stale. Same-process competing queue
  // instances are still protected by the token check in claimForRecovery.
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }
    return true;
  }
}

export class TaskMutationQueueConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskMutationQueueConflictError";
  }
}

function assertComponent(value: string, label: string): void {
  if (
    !value ||
    value.trim() !== value ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new Error(`Invalid ${label} for task mutation queue: ${value}`);
  }
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function ensureDirectory(directory: string): void {
  const parsed = path.parse(directory);
  let current = parsed.root;
  for (const component of path
    .relative(parsed.root, directory)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, component);
    let stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) {
      try {
        fs.mkdirSync(current);
      } catch (error) {
        if (!(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        )) {
          throw error;
        }
      }
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Unsafe task mutation queue directory: ${current}`);
    }
  }
}

export class TaskMutationQueue {
  private readonly filePath: string;
  private readonly projectId: string;
  private readonly ownerToken = randomUUID();

  constructor(rootDirectory: string, project: ProjectConfig) {
    if (!path.isAbsolute(rootDirectory))
      throw new Error("Task mutation queue root must be absolute");
    assertComponent(project.id, "project ID");
    const root = path.resolve(rootDirectory);
    if (
      within(root, path.resolve(project.repository.path)) ||
      within(path.resolve(project.repository.path), root) ||
      within(root, path.resolve(project.repository.worktreeRoot)) ||
      within(path.resolve(project.repository.worktreeRoot), root)
    )
      throw new Error(
        "Task mutation queue root must not overlap source or worktree roots",
      );
    this.projectId = project.id;
    this.filePath = path.join(
      root,
      "task-mutation-queues",
      `${project.id}.json`,
    );
  }

  enqueue(
    input: Omit<TaskMutationEvent, "status" | "ownerToken" | "ownerPid">,
  ): TaskMutationEvent {
    const event = eventSchema.parse({ ...input, status: "queued" });
    if (event.projectId !== this.projectId)
      throw new Error("Mutation event belongs to another project");
    return this.update((queue) => {
      const existing = queue.events.find(
        (item) => item.eventId === event.eventId,
      );
      if (existing !== undefined) {
        const comparable = (value: TaskMutationEvent) => ({
          ...value,
          enqueuedAt: undefined,
          status: undefined,
          ownerToken: undefined,
          ownerPid: undefined,
        });
        if (
          JSON.stringify(comparable(existing)) !==
          JSON.stringify(comparable(event))
        ) {
          throw new TaskMutationQueueConflictError(
            `Mutation event ID was reused: ${event.eventId}`,
          );
        }
        return { queue, result: existing };
      }
      const next = { ...queue, events: [...queue.events, event] };
      return { queue: next, result: event };
    });
  }

  list(): TaskMutationEvent[] {
    return this.readQueue().events;
  }

  getActive(): TaskMutationEvent | null {
    const queue = this.readQueue();
    return queue.activeEventId === null
      ? null
      : (queue.events.find((event) => event.eventId === queue.activeEventId) ??
          null);
  }

  ownsActive(eventId: string): boolean {
    const active = this.getActive();
    return (
      active?.eventId === eventId &&
      active.ownerToken === this.ownerToken &&
      liveMutationOwners.has(this.ownerToken)
    );
  }

  claimNext(): TaskMutationEvent | null {
    return this.update((queue) => {
      if (queue.activeEventId !== null) return { queue, result: null };
      const next = [...queue.events]
        .filter((event) => event.status === "queued")
        .sort(
          (left, right) =>
            left.enqueuedAt.localeCompare(right.enqueuedAt) ||
            left.cardId.localeCompare(right.cardId) ||
            left.eventId.localeCompare(right.eventId),
        )[0];
      if (next === undefined) return { queue, result: null };
      const claimed = {
        ...next,
        status: "active" as const,
        ownerToken: this.ownerToken,
        ownerPid: process.pid,
      };
      liveMutationOwners.add(this.ownerToken);
      return {
        queue: {
          ...queue,
          activeEventId: next.eventId,
          events: queue.events.map((event) =>
            event.eventId === next.eventId ? claimed : event,
          ),
        },
        result: claimed,
      };
    });
  }

  /** Reclaim a verified interrupted task before starting any queued work. */
  claimForRecovery(eventId: string): TaskMutationEvent | null {
    return this.update((queue) => {
      const target = queue.events.find((event) => event.eventId === eventId);
      if (target === undefined) return { queue, result: null };
      if (queue.activeEventId !== null) {
        if (queue.activeEventId !== eventId) return { queue, result: null };
        if (target.status === "active") {
          if (target.ownerToken === this.ownerToken)
            return { queue, result: target };
          if (
            (target.ownerToken !== undefined &&
              liveMutationOwners.has(target.ownerToken)) ||
            isProcessAlive(target.ownerPid)
          ) {
            return { queue, result: null };
          }
          const reclaimed = {
            ...target,
            ownerToken: this.ownerToken,
            ownerPid: process.pid,
          };
          liveMutationOwners.add(this.ownerToken);
          return {
            queue: {
              ...queue,
              events: queue.events.map((event) =>
                event.eventId === eventId ? reclaimed : event,
              ),
            },
            result: reclaimed,
          };
        }
        if (target.status !== "failed")
          throw new TaskMutationQueueConflictError(
            "Recovery event does not own the project queue",
          );
        const active = {
          ...target,
          status: "active" as const,
          ownerToken: this.ownerToken,
          ownerPid: process.pid,
        };
        liveMutationOwners.add(this.ownerToken);
        return {
          queue: {
            ...queue,
            events: queue.events.map((event) =>
              event.eventId === eventId ? active : event,
            ),
          },
          result: active,
        };
      }
      if (target.status !== "queued") return { queue, result: null };
      const active = {
        ...target,
        status: "active" as const,
        ownerToken: this.ownerToken,
        ownerPid: process.pid,
      };
      liveMutationOwners.add(this.ownerToken);
      return {
        queue: {
          ...queue,
          activeEventId: eventId,
          events: queue.events.map((event) =>
            event.eventId === eventId ? active : event,
          ),
        },
        result: active,
      };
    });
  }

  /**
   * Retire an orphaned Ready claim only after the caller has verified that the
   * card has no task record and is absent from both Ready and Working.
   * Never displace a different live process owner or a failed recovery event.
   */
  retireOrphanedReadyEvent(eventId: string): TaskMutationEvent {
    return this.update((queue) => {
      const current = queue.events.find((event) => event.eventId === eventId);
      if (
        current === undefined ||
        !["implementation", "refinement"].includes(current.kind) ||
        !["queued", "active"].includes(current.status)
      )
        throw new TaskMutationQueueConflictError(
          "Orphaned Ready event is not safely retireable",
        );
      if (current.status === "active") {
        if (queue.activeEventId !== eventId)
          throw new TaskMutationQueueConflictError(
            "Orphaned Ready event does not own the project queue",
          );
        if (
          current.ownerToken !== this.ownerToken &&
          ((current.ownerToken !== undefined &&
            liveMutationOwners.has(current.ownerToken)) ||
            isProcessAlive(current.ownerPid))
        )
          throw new TaskMutationQueueConflictError(
            "Orphaned Ready event has a live competing owner",
          );
      }
      if (current.status === "queued" && queue.activeEventId === eventId)
        throw new TaskMutationQueueConflictError(
          "Queued orphan unexpectedly owns the project queue",
        );
      if (current.ownerToken !== undefined)
        liveMutationOwners.delete(current.ownerToken);
      const retired = {
        ...current,
        status: "retired" as const,
        retiredAt: new Date().toISOString(),
        retirementReason: "card-left-ready" as const,
        ownerToken: undefined,
        ownerPid: undefined,
      };
      return {
        queue: {
          ...queue,
          activeEventId:
            queue.activeEventId === eventId ? null : queue.activeEventId,
          events: queue.events.map((event) =>
            event.eventId === eventId ? retired : event,
          ),
        },
        result: retired,
      };
    });
  }

  /**
   * Narrow recovery for legacy PR #205 events, whose completed status cannot
   * distinguish retirement from successful execution. The caller must verify
   * task/Trello ownership and explicitly attest that execution never began.
   */
  retireLegacyCompletedEvent(
    eventId: string,
    confirmedNeverStarted: boolean,
  ): TaskMutationEvent {
    if (!confirmedNeverStarted)
      throw new TaskMutationQueueConflictError(
        "Legacy mutation recovery requires explicit never-started confirmation",
      );
    return this.update((queue) => {
      const current = queue.events.find((event) => event.eventId === eventId);
      if (
        current === undefined ||
        !["implementation", "refinement"].includes(current.kind) ||
        current.status !== "completed" ||
        queue.activeEventId !== null
      )
        throw new TaskMutationQueueConflictError(
          "Legacy mutation is not safely recoverable",
        );
      const retired = {
        ...current,
        status: "retired" as const,
        retiredAt: new Date().toISOString(),
        retirementReason: "operator-confirmed-never-started" as const,
      };
      return {
        queue: {
          ...queue,
          events: queue.events.map((event) =>
            event.eventId === eventId ? retired : event,
          ),
        },
        result: retired,
      };
    });
  }

  complete(eventId: string): TaskMutationEvent {
    return this.finish(eventId, "completed");
  }

  fail(eventId: string): TaskMutationEvent {
    return this.finish(eventId, "failed");
  }

  /** Relinquish ownership while retaining the active event for restart recovery. */
  releaseForRecovery(eventId: string): TaskMutationEvent {
    return this.update((queue) => {
      if (queue.activeEventId !== eventId)
        throw new TaskMutationQueueConflictError(
          "Mutation event does not own the project queue",
        );
      const current = queue.events.find((event) => event.eventId === eventId);
      if (
        current?.status !== "active" ||
        current.ownerToken !== this.ownerToken
      ) {
        throw new TaskMutationQueueConflictError(
          "Mutation event is not owned by this recovery worker",
        );
      }
      liveMutationOwners.delete(this.ownerToken);
      const released = {
        ...current,
        ownerToken: undefined,
        ownerPid: undefined,
      };
      return {
        queue: {
          ...queue,
          events: queue.events.map((event) =>
            event.eventId === eventId ? released : event,
          ),
        },
        result: released,
      };
    });
  }

  requeueAfterVerifiedRecovery(eventId: string): TaskMutationEvent {
    return this.finish(eventId, "queued");
  }

  private finish(
    eventId: string,
    status: "completed" | "failed" | "queued",
  ): TaskMutationEvent {
    return this.update((queue) => {
      if (queue.activeEventId !== eventId)
        throw new TaskMutationQueueConflictError(
          "Mutation event does not own the project queue",
        );
      const current = queue.events.find((event) => event.eventId === eventId);
      if (
        current === undefined ||
        (current.status !== "active" &&
          !(status === "queued" && current.status === "failed"))
      )
        throw new TaskMutationQueueConflictError(
          "Active mutation event disappeared",
        );
      if (
        current.status === "active" &&
        current.ownerToken !== this.ownerToken
      ) {
        throw new TaskMutationQueueConflictError(
          "Mutation event is owned by another polling worker",
        );
      }
      if (current.ownerToken !== undefined)
        liveMutationOwners.delete(current.ownerToken);
      const next = {
        ...current,
        status,
        ownerToken: undefined,
        ownerPid: undefined,
      };
      return {
        queue: {
          ...queue,
          activeEventId: status === "failed" ? eventId : null,
          events: queue.events.map((event) =>
            event.eventId === eventId ? next : event,
          ),
        },
        result: next,
      };
    });
  }

  private readQueue(): QueueRecord {
    const stat = fs.lstatSync(this.filePath, { throwIfNoEntry: false });
    if (stat === undefined)
      return {
        version: 1,
        projectId: this.projectId,
        revision: 1,
        activeEventId: null,
        events: [],
      };
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error("Unsafe task mutation queue file");
    const queue = queueSchema.parse(
      JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown,
    );
    if (queue.projectId !== this.projectId)
      throw new Error("Task mutation queue owner mismatch");
    return queue;
  }

  private update<T>(
    operation: (queue: QueueRecord) => { queue: QueueRecord; result: T },
  ): T {
    ensureDirectory(path.dirname(this.filePath));
    return this.withLock(() => {
      const current = this.readQueue();
      const output = operation(current);
      if (output.queue === current) return output.result;
      this.write({ ...output.queue, revision: current.revision + 1 });
      return output.result;
    });
  }

  private write(queueInput: QueueRecord): void {
    const queue = queueSchema.parse(queueInput);
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(queue, null, 2)}\n`, "utf8");
      fs.fsyncSync(fd);
    } catch (error) {
      fs.closeSync(fd);
      fs.unlinkSync(temporary);
      throw error;
    }
    fs.closeSync(fd);
    try {
      fs.renameSync(temporary, this.filePath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  private withLock<T>(operation: () => T): T {
    const lockPath = `${this.filePath}.lock`;
    let fd: number;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        throw new TaskMutationQueueConflictError(
          "Another task mutation owns the project queue",
        );
      }
      throw error;
    }
    try {
      return operation();
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lockPath);
    }
  }
}
