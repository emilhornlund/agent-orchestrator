import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import {
  isVerifiedStoppedExecution,
  isVerifiedSuccessfulExecution,
} from "../process/process-runtime.js";
import { logger } from "../logging/logger.js";

const capacitySchema = z.strictObject({
  version: z.literal(1),
  state: z.enum(["idle", "queued", "active"]),
  sequence: z.number().int().positive().safe(),
  requestedAt: z.string().datetime(),
  executions: z
    .array(
      z.strictObject({
        executionId: z.string().uuid(),
        metadataPath: z.string(),
        cwd: z.string(),
        command: z.string(),
      }),
    )
    .optional(),
});
type CapacityRecord = z.infer<typeof capacitySchema>;
const key = "ai-execution-capacity";
const scope = new AsyncLocalStorage<{
  capacity: AiExecutionCapacity;
  signal: AbortSignal;
}>();
const held = new AsyncLocalStorage<{
  capacity: AiExecutionCapacity;
  attemptId: string;
  token: symbol;
}>();

export class AiCapacityCancelledError extends Error {
  constructor() {
    super("AI capacity acquisition cancelled before execution");
    this.name = "AiCapacityCancelledError";
  }
}

function read(authority: ProjectRunAuthority): CapacityRecord | null {
  return authority.read(key, (value) => capacitySchema.parse(value));
}
function write(authority: ProjectRunAuthority, value: CapacityRecord): void {
  authority.mutate(
    key,
    value,
    () => ({ value, result: undefined }),
    (raw) => capacitySchema.parse(raw),
  );
}

function stopped(authority: ProjectRunAuthority, record: CapacityRecord): boolean {
  // Dispatch binds every nested execution before spawning. No binding is durable
  // evidence of no dispatch through this capacity reservation, not PID absence.
  return (record.executions ?? []).every(({ executionId, metadataPath, cwd, command }) => {
    const root = path.resolve(authority.store.storageRoot);
    const relative = path.relative(root, metadataPath);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
      return false;
    try {
      let current = root;
      if (fs.realpathSync(root) !== root) return false;
      for (const part of relative.split(path.sep)) {
        current = path.join(current, part);
        if (fs.lstatSync(current).isSymbolicLink()) return false;
      }
      const stat = fs.lstatSync(metadataPath);
      if (!stat.isFile() || stat.size > 64 * 1024) return false;
      const evidence: unknown = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      const expected = { executionId, cwd, command };
      return (
        isVerifiedStoppedExecution(evidence, expected) ||
        isVerifiedSuccessfulExecution(evidence, expected) ||
        (typeof evidence === "object" &&
          evidence !== null &&
          "executionId" in evidence &&
          evidence.executionId === executionId &&
          "status" in evidence &&
          evidence.status === "not-dispatched" &&
          "cwd" in evidence &&
          evidence.cwd === cwd &&
          "command" in evidence &&
          evidence.command === command)
      );
    } catch {
      return false;
    }
  });
}

interface Waiter {
  authority: ProjectRunAuthority;
  record: CapacityRecord;
  resolve: () => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

/** One instance's project-wide AI slots. Request order lives in the existing
 * authoritative attempts, not a second state store. Dormant recovery/dependency
 * waits do not acquire a slot; ready requests retain their durable FCFS ticket. */
export class AiExecutionCapacity {
  private sequence = 0;
  private readonly active = new Map<string, ProjectRunAuthority>();
  private readonly liveTokens = new Map<string, symbol>();
  private readonly known = new Map<string, ProjectRunAuthority>();
  private readonly waiters = new Map<string, Waiter>();
  constructor(
    readonly limit: number,
    authorities: readonly ProjectRunAuthority[] = [],
    private readonly recheckMs = 1000,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("AI concurrency limit must be a positive safe integer");
    for (const authority of authorities) {
      this.known.set(authority.attemptScopeKey, authority);
      let record: CapacityRecord | null;
      try {
        record = read(authority);
      } catch {
        this.active.set(authority.attemptScopeKey, authority);
        logger
          .child({ projectId: authority.projectId })
          .warn(
            "AI capacity state cannot be verified; preserving one occupied slot and the original attempt for reconciliation",
          );
        continue;
      }
      if (!record) continue;
      this.sequence = Math.max(this.sequence, record.sequence);
      if (record.state === "active") {
        if (stopped(authority, record))
          write(authority, { ...record, state: "idle", executions: undefined });
        else this.active.set(authority.attemptScopeKey, authority);
      }
    }
  }

  async runInScope<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const timer = setInterval(() => {
      if (!signal.aborted) this.pump();
    }, this.recheckMs);
    try {
      return await scope.run({ capacity: this, signal }, operation);
    } finally {
      clearInterval(timer);
    }
  }

  async run<T>(
    authority: ProjectRunAuthority,
    signal: AbortSignal,
    shutdown: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const attemptId = authority.attemptScopeKey;
    this.known.set(attemptId, authority);
    if (signal.aborted || shutdown.aborted) throw new AiCapacityCancelledError();
    const nested = held.getStore();
    if (
      nested?.capacity === this &&
      nested.attemptId === attemptId &&
      this.liveTokens.get(attemptId) === nested.token
    )
      return operation();
    if (this.waiters.has(attemptId))
      throw new Error("Project already has a pending AI capacity request");
    if (this.active.has(attemptId)) {
      if (this.liveTokens.has(attemptId))
        throw new Error("Project already has a live AI execution slot");
      const prior = read(authority);
      if (!prior || !stopped(authority, prior))
        throw new Error(
          "Prior AI execution has unknown liveness; capacity and project ownership retained",
        );
      this.active.delete(attemptId);
      write(authority, { ...prior, state: "idle", executions: undefined });
    }
    const previous = read(authority);
    const record: CapacityRecord =
      previous?.state === "queued"
        ? previous
        : {
            version: 1,
            state: "queued",
            sequence: ++this.sequence,
            requestedAt: new Date().toISOString(),
          };
    this.sequence = Math.max(this.sequence, record.sequence);
    write(authority, record);
    await new Promise<void>((resolve, reject) => {
      const cancel = () => {
        const waiter = this.waiters.get(attemptId);
        if (!waiter) return;
        this.waiters.delete(attemptId);
        waiter.cleanup();
        // Shutdown preserves an unserved ticket for restart. Deliberate local
        // cancellation relinquishes it without pretending a process dispatched.
        try {
          if (!shutdown.aborted) write(authority, { ...record, state: "idle" });
          reject(new AiCapacityCancelledError());
        } catch (error) {
          this.known.delete(attemptId); // No dispatch occurred; retain the record.
          reject(
            error instanceof Error
              ? error
              : new Error("AI capacity cancellation could not be persisted"),
          );
        }
        this.pump();
      };
      const cleanup = () => {
        signal.removeEventListener("abort", cancel);
        shutdown.removeEventListener("abort", cancel);
      };
      this.waiters.set(attemptId, {
        authority,
        record,
        resolve,
        reject,
        cleanup,
      });
      signal.addEventListener("abort", cancel, { once: true });
      shutdown.addEventListener("abort", cancel, { once: true });
      this.pump();
    });
    try {
      if (signal.aborted || shutdown.aborted) throw new AiCapacityCancelledError();
      return await held.run(
        { capacity: this, attemptId, token: this.liveTokens.get(attemptId)! },
        operation,
      );
    } finally {
      try {
        const latest = read(authority);
        if (latest && stopped(authority, latest)) {
          write(authority, { ...latest, state: "idle", executions: undefined });
          this.active.delete(attemptId);
        }
      } finally {
        this.liveTokens.delete(attemptId);
        this.pump();
      }
    }
  }

  bindExecution(
    authority: ProjectRunAuthority,
    evidence: { executionId: string; metadataPath: string },
    cwd: string,
    command: string,
  ): void {
    const record = read(authority);
    if (!record || record.state !== "active" || !this.active.has(authority.attemptScopeKey))
      throw new Error("AI process cannot dispatch without its project execution slot");
    write(authority, {
      ...record,
      executions: [
        ...(record.executions ?? []),
        {
          executionId: evidence.executionId,
          metadataPath: evidence.metadataPath,
          cwd,
          command,
        },
      ],
    });
  }

  private pump(): void {
    for (const [attemptId, authority] of this.active) {
      if (this.liveTokens.has(attemptId)) continue;
      try {
        const record = read(authority);
        if (record && stopped(authority, record)) {
          write(authority, { ...record, state: "idle", executions: undefined });
          this.active.delete(attemptId);
        }
      } catch {
        /* Unknown state retains capacity; never infer stopped from absence. */
      }
    }
    while (this.active.size < this.limit && this.waiters.size > 0) {
      const candidates = [...this.known.values()]
        .flatMap((authority) => {
          let record: CapacityRecord | null;
          let waiting: boolean;
          try {
            record = read(authority);
            waiting = authority.store.read()?.lifecycle === "waiting";
          } catch {
            return [];
          }
          if (
            !record ||
            record.state !== "queued" ||
            (waiting && !this.waiters.has(authority.attemptScopeKey))
          )
            return [];
          return [{ authority, record }];
        })
        .sort(
          (a, b) =>
            a.record.sequence - b.record.sequence ||
            a.record.requestedAt.localeCompare(b.record.requestedAt) ||
            a.authority.attemptScopeKey.localeCompare(b.authority.attemptScopeKey),
        );
      const first = candidates[0];
      if (!first) return;
      const next = this.waiters.get(first.authority.attemptScopeKey);
      if (!next) return; // A restored earlier ticket is still reconciling.
      this.waiters.delete(next.authority.attemptScopeKey);
      next.cleanup();
      try {
        write(next.authority, {
          ...next.record,
          state: "active",
          executions: undefined,
        });
        this.active.set(next.authority.attemptScopeKey, next.authority);
        this.liveTokens.set(next.authority.attemptScopeKey, Symbol("ai-slot"));
        next.resolve();
      } catch (error) {
        next.reject(error instanceof Error ? error : new Error("AI capacity ownership changed"));
      }
    }
  }
}

export async function withAiExecutionCapacity<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const current = scope.getStore();
  if (!current) return operation();
  const projectId = ProjectRunAuthority.currentProjectId();
  const authority = projectId ? ProjectRunAuthority.current(projectId) : undefined;
  if (!authority) throw new Error("Configured AI capacity requires canonical task ownership");
  return current.capacity.run(authority, signal ?? current.signal, current.signal, operation);
}

export function hasAiExecutionCapacity(): boolean {
  return scope.getStore() !== undefined;
}

export function bindAiCapacityExecution(
  evidence: { executionId: string; metadataPath: string },
  cwd: string,
  command: string,
): void {
  const current = scope.getStore();
  if (!current) return;
  const projectId = ProjectRunAuthority.currentProjectId();
  const authority = projectId ? ProjectRunAuthority.current(projectId) : undefined;
  if (!authority) throw new Error("AI execution evidence has no canonical task authority");
  current.capacity.bindExecution(authority, evidence, cwd, command);
}
