import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { sanitizeControlledText } from "../security/redact-secrets.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import type { EmailMessage, EmailNotifier } from "./email-notifier.js";
import { RunStore } from "../task-session/run-store.js";
import { parseRunRecord } from "../task-session/run-record.js";
import {
  refinementMutationSnapshotKey,
  refinementMutationSnapshotSchema,
} from "../refinement/refinement-mutation-snapshot.js";

export class NotificationNotDeliveredError extends Error {}
export class NotificationPreparationError extends Error {}
const triggerSchema = z.strictObject({
  cardId: z.string().min(1),
  listId: z.string().min(1),
  boardId: z.string().min(1),
  since: z.string().datetime().optional(),
  dueComplete: z.boolean().optional(),
  binding: z
    .strictObject({
      attemptId: z
        .string()
        .min(1)
        .refine((id) => path.basename(id) === id && id !== "." && id !== ".."),
      operationId: z.string().min(1),
      payloadId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
      executionGeneration: z.number().int().nonnegative(),
      refinementHash: z.string().optional(),
    })
    .optional(),
});
export type NotificationTrigger = z.infer<typeof triggerSchema>;
export function notificationTriggerObserver(
  root: string,
  projectId: string,
  assertHeld: () => void,
): (trigger: NotificationTrigger) => Promise<boolean> {
  return async (trigger) => {
    // Legacy unbound triggers are retained, never upgraded using unrelated card
    // position/history. Only the original attempt's concrete verified effect counts.
    if (!trigger.binding) return false;
    const run = readNotificationAttempt(
      root,
      trigger.binding.attemptId,
      assertHeld,
    );
    if (
      run.projectId !== projectId ||
      run.cardId !== trigger.cardId ||
      run.pinned.boardId !== trigger.boardId
    )
      return false;
    if (
      run.taskKind === "refinement" &&
      trigger.listId === run.pinned.lists.failed &&
      (run.lifecycle !== "failed" || run.terminalSync !== "verified")
    )
      return false;
    const op = run.pendingOperations.find(
      (entry) => entry.id === trigger.binding!.operationId,
    );
    if (
      op?.status !== "completed" ||
      op.mutation?.intent.kind !== "trello-move" ||
      op.mutation.intent.target !==
        `trello:${trigger.boardId}:${trigger.cardId}` ||
      op.mutation.intent.payloadId !== trigger.binding.payloadId ||
      op.mutation.executionFence.generation !==
        trigger.binding.executionGeneration
    )
      return false;
    const observed = op.mutation.observations.find(
      (entry) => entry.outcome === "verified",
    );
    if (!observed) return false;
    const payload = readRunArtifact(run, op.mutation.intent.payloadId);
    const expected = {
      route: "trello-move",
      args: {
        cardId: trigger.cardId,
        listId: trigger.listId,
        options:
          trigger.dueComplete === undefined
            ? {}
            : { dueComplete: trigger.dueComplete },
      },
    };
    if (JSON.stringify(payload) !== JSON.stringify(expected)) return false;
    const observation = z
      .object({
        fields: z.object({
          id: z.string(),
          idList: z.string(),
          name: z.string(),
          desc: z.string(),
          idLabels: z.array(z.string()),
        }),
      })
      .parse(readRunArtifact(run, observed.evidence.artifactId));
    if (
      observation.fields.id !== trigger.cardId ||
      observation.fields.idList !== trigger.listId
    )
      return false;
    if (trigger.binding.refinementHash) {
      const snapshot = refinementMutationSnapshotSchema.parse(
        run.compatibility[refinementMutationSnapshotKey],
      );
      if (
        run.taskKind !== "refinement" ||
        snapshot.cardId !== trigger.cardId ||
        hash(JSON.stringify(snapshot.intended)) !==
          trigger.binding.refinementHash
      )
        return false;
      if (
        observation.fields.name !== snapshot.intended.title ||
        observation.fields.desc !== snapshot.intended.description ||
        JSON.stringify([...observation.fields.idLabels].sort()) !==
          JSON.stringify([...snapshot.intended.labels].sort())
      )
        return false;
    }
    return true;
  };
}
function readNotificationAttempt(
  root: string,
  attemptId: string,
  assertHeld: () => void,
) {
  assertHeld();
  const file = path.join(root, "attempts", `${attemptId}.json`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
    throw new Error("Unsafe notification source attempt");
  const run = parseRunRecord(JSON.parse(fs.readFileSync(file, "utf8")));
  // Read-only under the project lease. No ownership takeover, registry or
  // workflow write: RunStore validates pinned paths and artifact integrity.
  return RunStore.openWithPersistedIdentity(root, attemptId, {
    integrationId: run.pinned.integrationId,
    instanceId: "notification-observer",
    token: "read-only",
    assertHeld,
  })!.read()!;
}
function readRunArtifact(
  run: ReturnType<typeof readNotificationAttempt>,
  id: string,
): unknown {
  const ref = run.artifacts.find((entry) => entry.id === id);
  if (!ref) throw new Error("Notification evidence missing");
  return JSON.parse(fs.readFileSync(ref.path, "utf8")) as unknown;
}
const outcome = z.enum(["known-not-delivered", "ambiguous", "confirmed"]);
export const notificationObligationSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(/^[a-f0-9]{64}$/u),
  projectId: z.string().min(1),
  eventKey: z.string().min(1),
  event: z.enum([
    "humanReview",
    "failed",
    "refinementComplete",
    "done",
    "attentionRequired",
  ]),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
  targetHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  message: z.strictObject({ subject: z.string(), text: z.string() }),
  messageId: z.string().min(1),
  createdAt: z.string().datetime(),
  trigger: triggerSchema.optional(),
});
export type NotificationObligation = z.infer<
  typeof notificationObligationSchema
>;
const recordSchema = notificationObligationSchema.extend({
  revision: z.number().int().nonnegative().safe(),
  dispatches: z.array(
    z.strictObject({
      at: z.string().datetime(),
      outcome,
      evidence: z.string(),
      providerId: z.string().optional(),
    }),
  ),
  retryAt: z.string().datetime().nullable(),
});
export type NotificationDeliveryRecord = z.infer<typeof recordSchema>;
export function createNotificationObligation(
  projectId: string,
  eventKey: string,
  message: EmailMessage,
  event: NotificationDeliveryRecord["event"],
  deliveryTarget?: string,
  trigger?: NotificationTrigger,
  now = Date.now(),
): NotificationObligation {
  const sanitized = {
    subject: sanitizeControlledText(message.subject),
    text: sanitizeControlledText(message.text),
  };
  const key = sanitizeControlledText(eventKey);
  const id = hash(key);
  return notificationObligationSchema.parse({
    version: 1,
    id,
    projectId,
    eventKey: key,
    event,
    payloadHash: hash(JSON.stringify(sanitized)),
    targetHash: deliveryTarget === undefined ? null : hash(deliveryTarget),
    message: sanitized,
    messageId: `<${id}@agent-orchestrator.invalid>`,
    createdAt: new Date(now).toISOString(),
    ...(trigger ? { trigger } : {}),
  });
}
const context = new AsyncLocalStorage<NotificationOutbox>();
// Scheduling guard only: durable records, not this map, decide resend safety.
const activeSenders = new Map<string, Promise<void>>();
export const NOTIFICATION_RECHECK_MS = 15_000;
const storageWaitSchema = z.strictObject({ retryAt: z.string().datetime() });
const storageWaitKey = "notification-storage-wait";
const localStorageWaits = new Map<string, number>(); // pacing fallback, never workflow authority
export function deferNotificationPreparation(
  projectId: string,
  report: (message: string) => void,
): void {
  const authority = ProjectRunAuthority.current(projectId);
  const key = `${projectId}:${authority?.store.attemptId ?? "project"}`;
  localStorageWaits.set(key, Date.now() + NOTIFICATION_RECHECK_MS);
  if (authority) {
    const wait = {
      retryAt: new Date(Date.now() + NOTIFICATION_RECHECK_MS).toISOString(),
    };
    try {
      authority.mutate(
        storageWaitKey,
        wait,
        () => ({ value: wait, result: undefined }),
        storageWaitSchema.parse,
      );
    } catch {
      report(
        "Notification handoff wait could not be checkpointed; existing attempt/queue remains owned; local paced storage recovery continues",
      );
    }
  }
  report(
    "Notification initial handoff storage unavailable; task/queue retained for paced recovery; no engineering failure or recursive email attention",
  );
}
export function notificationPreparationDue(projectId: string): boolean {
  const authority = ProjectRunAuthority.current(projectId);
  const key = `${projectId}:${authority?.store.attemptId ?? "project"}`;
  if ((localStorageWaits.get(key) ?? 0) > Date.now()) return false;
  localStorageWaits.delete(key);
  const wait = authority?.read(storageWaitKey, storageWaitSchema.parse);
  if (!wait) return true;
  if (Date.now() < Date.parse(wait.retryAt)) return false;
  authority!.remove(storageWaitKey);
  return true;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function safeDirectory(directory: string): void {
  let current = path.parse(directory).root;
  for (const segment of directory
    .slice(current.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      fs.mkdirSync(current, { mode: 0o700 });
      syncDirectory(path.dirname(current));
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("Unsafe notification storage path");
  }
}
function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Notification-only authority. No workflow state, registry pointer or release gate
 * is changed here. The canonical project lease serializes every writer, including
 * delivery of old attempts after the active attempt has been replaced. */
export class NotificationOutbox {
  private readonly directory: string;
  constructor(
    private readonly root: string,
    readonly projectId: string,
    private readonly assertHeld: () => void,
    private readonly clock: () => number = Date.now,
    private readonly observeTrigger?: (
      trigger: NotificationTrigger,
    ) => Promise<boolean>,
  ) {
    if (!path.isAbsolute(root))
      throw new Error("Notification storage must be external and absolute");
    this.directory = path.join(root, "notifications", hash(projectId));
  }
  run<T>(operation: () => T): T {
    return context.run(this, operation);
  }
  static current(projectId: string): NotificationOutbox | undefined {
    const scoped = context.getStore();
    if (scoped) {
      if (scoped.projectId !== projectId)
        throw new Error("Notification project scope mismatch");
      return scoped;
    }
    const authority = ProjectRunAuthority.current(projectId);
    return authority
      ? new NotificationOutbox(
          authority.store.storageRoot,
          projectId,
          () => authority.assertHeld(),
          Date.now,
          notificationTriggerObserver(
            authority.store.storageRoot,
            projectId,
            () => authority.assertHeld(),
          ),
        )
      : undefined;
  }
  private read(file: string): NotificationDeliveryRecord {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      throw new Error("Unsafe notification record");
    const record = recordSchema.parse(
      JSON.parse(fs.readFileSync(file, "utf8")),
    );
    if (
      record.projectId !== this.projectId ||
      path.basename(file) !== `${record.id}.json` ||
      record.id !== hash(record.eventKey) ||
      record.payloadHash !== hash(JSON.stringify(record.message)) ||
      record.messageId !== `<${record.id}@agent-orchestrator.invalid>` ||
      (record.trigger !== undefined && record.dispatches.length > 0) ||
      record.dispatches
        .slice(0, -1)
        .some((entry) => entry.outcome !== "known-not-delivered")
    )
      throw new Error("Notification identity mismatch");
    return record;
  }
  private write(record: NotificationDeliveryRecord): void {
    this.assertHeld();
    recordSchema.parse(record);
    safeDirectory(this.directory);
    const file = path.join(this.directory, `${record.id}.json`);
    const prior = fs.existsSync(file) ? this.read(file) : null;
    if ((prior?.revision ?? 0) !== record.revision)
      throw new Error("Notification revision conflict");
    record.revision++;
    const temporary = `${file}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(record));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.assertHeld();
    fs.renameSync(temporary, file);
    syncDirectory(this.directory);
  }
  enqueue(
    eventKey: string,
    message: EmailMessage,
    event: NotificationDeliveryRecord["event"] = "humanReview",
    deliveryTarget?: string,
    trigger?: NotificationTrigger,
  ): NotificationDeliveryRecord {
    return this.materialize(
      createNotificationObligation(
        this.projectId,
        eventKey,
        message,
        event,
        deliveryTarget,
        trigger,
        this.clock(),
      ),
    );
  }
  materialize(obligation: NotificationObligation): NotificationDeliveryRecord {
    this.assertHeld();
    safeDirectory(this.directory);
    notificationObligationSchema.parse(obligation);
    const { id } = obligation;
    if (obligation.projectId !== this.projectId)
      throw new Error("Notification project mismatch");
    const file = path.join(this.directory, `${id}.json`);
    if (fs.existsSync(file)) {
      // Identity names the observed event, not a pre-send delivery claim. Later
      // rendering/timing changes must not create a duplicate of that event.
      return this.read(file);
    }
    const record: NotificationDeliveryRecord = {
      ...obligation,
      revision: 0,
      dispatches: [],
      retryAt: null,
    };
    this.write(record);
    return record;
  }
  records(): NotificationDeliveryRecord[] {
    this.assertHeld();
    safeDirectory(this.directory);
    return fs
      .readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => this.read(path.join(this.directory, name)));
  }
  start(
    notifier: EmailNotifier,
    report: (message: string) => void,
    observeTrigger = this.observeTrigger,
  ): void {
    if (activeSenders.has(this.directory)) return;
    const pending = this.drain(notifier, report, observeTrigger)
      .catch(() => {
        report(
          "Notification delivery/storage unavailable; workflow is unchanged; preserved outbox requires inspection",
        );
      })
      .finally(() => {
        activeSenders.delete(this.directory);
      });
    activeSenders.set(this.directory, pending);
  }
  async drain(
    notifier: EmailNotifier,
    report: (message: string) => void,
    observeTrigger = this.observeTrigger,
  ): Promise<void> {
    const attempts = path.join(this.root, "attempts");
    if (fs.existsSync(attempts)) {
      safeDirectory(attempts);
      for (const name of fs
        .readdirSync(attempts)
        .filter((entry) => entry.endsWith(".json"))) {
        try {
          const run = readNotificationAttempt(
            this.root,
            name.slice(0, -5),
            this.assertHeld,
          );
          if (run.projectId !== this.projectId) continue;
          // Validate the whole source's event set before deriving any delivery
          // record from it. An invalid source is retained, not partially trusted.
          const obligations = Object.entries(run.compatibility)
            .filter(([key]) => key.startsWith("notification-event-"))
            .map(([, value]) => notificationObligationSchema.parse(value));
          for (const obligation of obligations) this.materialize(obligation);
        } catch {
          // A shared runtime root is not a shared failure domain. In particular,
          // unreadable/unsupported attempts and missing/corrupt artifacts must
          // not prevent another project or existing outbox records from draining.
          // Lease loss is different: rethrow it before any further work.
          this.assertHeld();
          report(
            `Notification source attempt filename sha256:${hash(name)} unavailable or invalid; evidence preserved; continuing other sources and existing delivery records`,
          );
        }
      }
    }
    // Bounded pass, no retry loop. Dispatch is ambiguous durably BEFORE transport.
    let actionable = 0;
    for (const candidate of this.records()
      .filter(
        (entry) =>
          entry.dispatches.at(-1)?.outcome !== "confirmed" &&
          (notifier.isEventEnabled?.(entry.event) ?? true),
      )
      .sort(
        (a, b) =>
          Date.parse(a.retryAt ?? a.createdAt) -
          Date.parse(b.retryAt ?? b.createdAt),
      )) {
      const record = this.read(
        path.join(this.directory, `${candidate.id}.json`),
      );
      const last = record.dispatches.at(-1);
      if (
        record.targetHash !== null &&
        record.targetHash !== hash(notifier.deliveryTarget ?? "")
      ) {
        report(
          `Notification ${record.id}: configured transport/recipient identity changed; preserved without dispatch`,
        );
        continue;
      }
      if (last?.outcome === "confirmed") continue;
      if (record.retryAt && Date.parse(record.retryAt) > this.clock()) continue;
      if (actionable++ >= 100) break;
      this.assertHeld();
      if (record.trigger) {
        record.retryAt = new Date(
          this.clock() + NOTIFICATION_RECHECK_MS,
        ).toISOString();
        this.write(record);
        let verified: boolean | undefined;
        try {
          verified = await observeTrigger?.(record.trigger);
        } catch {
          this.assertHeld();
          report(
            `Notification ${record.id}: workflow event observation unavailable; prepared obligation retained`,
          );
          continue;
        }
        if (!verified) {
          report(
            `Notification ${record.id}: prepared workflow event awaits destination verification; no delivery attempted`,
          );
          continue;
        }
        this.assertHeld();
        delete record.trigger;
        this.write(record);
      }
      if (last?.outcome === "ambiguous") {
        record.retryAt = new Date(
          this.clock() + NOTIFICATION_RECHECK_MS,
        ).toISOString();
        this.write(record);
        let observed:
          "confirmed" | "known-not-delivered" | "ambiguous" | undefined;
        try {
          observed = await notifier.lookupDelivery?.(record.messageId);
        } catch {
          this.assertHeld();
          report(
            `Notification ${record.id}: provider lookup unavailable; acceptance remains uncertain; no resend`,
          );
          continue;
        }
        this.assertHeld();
        if (observed === "confirmed" || observed === "known-not-delivered") {
          last.outcome = observed;
          last.evidence = "Provider correlation lookup";
        } else {
          report(
            `Notification ${record.id}: SMTP acceptance uncertain; no automatic resend; inspect provider using ${record.messageId}`,
          );
        }
        record.retryAt = new Date(
          this.clock() + NOTIFICATION_RECHECK_MS,
        ).toISOString();
        this.write(record);
        continue;
      }
      record.dispatches.push({
        at: new Date(this.clock()).toISOString(),
        outcome: "ambiguous",
        evidence: "Dispatch checkpoint; acceptance unknown",
      });
      record.retryAt = new Date(
        this.clock() + NOTIFICATION_RECHECK_MS,
      ).toISOString();
      this.write(record);
      try {
        const receipt = await notifier.send({
          ...record.message,
          messageId: record.messageId,
        });
        this.assertHeld();
        record.dispatches.at(-1)!.outcome = "confirmed";
        record.dispatches.at(-1)!.evidence =
          "Transport confirmed relay acceptance (not recipient receipt)";
        if (receipt) {
          record.dispatches.at(-1)!.providerId = sanitizeControlledText(
            receipt.providerId,
          );
          if (receipt.partial) {
            record.dispatches.at(-1)!.evidence =
              "Partial recipient acceptance; automatic resend suppressed to avoid duplicating accepted recipients";
            report(
              `Notification ${record.id}: partial recipient acceptance; inspect provider; no whole-message resend`,
            );
          }
        }
      } catch (error) {
        this.assertHeld();
        record.dispatches.at(-1)!.outcome =
          error instanceof NotificationNotDeliveredError
            ? "known-not-delivered"
            : "ambiguous";
        record.dispatches.at(-1)!.evidence =
          error instanceof NotificationNotDeliveredError
            ? "Transport proved rejection before acceptance"
            : "Transport did not establish acceptance or non-delivery";
        report(
          `Notification ${record.id}: ${record.dispatches.at(-1)!.outcome}`,
        );
      }
      this.write(record);
    }
  }
}

/** Best-effort delivery is never an input to workflow transitions. */
export function drainNotifications(
  projectId: string,
  notifier: EmailNotifier | undefined,
  report: (message: string) => void,
  observeTrigger?: (trigger: NotificationTrigger) => Promise<boolean>,
): void {
  if (!notifier) return;
  try {
    NotificationOutbox.current(projectId)?.start(
      notifier,
      report,
      observeTrigger,
    );
  } catch {
    report(
      "Notification delivery/storage unavailable; workflow is unchanged; preserved outbox requires inspection",
    );
  }
}
