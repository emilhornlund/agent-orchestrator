import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProjectConfig } from "../config/config.js";
import { logger } from "../logging/logger.js";
import { notifyAttentionRequired, type EmailNotifier } from "../notifications/email-notifier.js";
import { FeedbackClassificationError } from "./classify-current-feedback.js";
import { OPERATION_RECOVERY_MAX_EXECUTIONS } from "./operation-recovery-policy.js";
import { ProjectRunAuthority } from "./project-run-authority.js";
import { TaskExecutionStore } from "./task-execution-store.js";

const key = "feedback-classification-v1";
const checkpointSchema = z.strictObject({
  identity: z.string().regex(/^[a-f0-9]{64}$/u),
  revisions: z.array(z.string()).optional(),
  since: z.string().datetime(),
  status: z.enum(["running", "waiting", "blocked", "recovered"]),
  failures: z.number().int().nonnegative(),
  outages: z.number().int().nonnegative(),
  retryAt: z.string().datetime().nullable(),
  classification: z.string().optional(),
  executionId: z.uuid().optional(),
  attentionPrepared: z.boolean().optional(),
});
type Checkpoint = z.infer<typeof checkpointSchema>;
const checkpoints = z.record(z.string().regex(/^[a-f0-9]{64}$/u), checkpointSchema);

/** The classification checkpoint is separate from the feedback ledger: unavailable
 * results cannot supersede or complete any request, or release the mutation owner. */
export function feedbackClassificationCheckpoint(options: {
  project: ProjectConfig;
  cardId: string;
  pullRequestUrl: string;
  worktreePath: string;
  emailNotifier?: EmailNotifier;
}) {
  const { project, cardId, pullRequestUrl } = options;
  const authority = ProjectRunAuthority.current(project.id);
  if (!authority || authority.cardId !== cardId) return undefined;
  const log = logger.child({ projectId: project.id, cardId });
  const store = new TaskExecutionStore(authority.store.storageRoot, project, authority);
  const read = () => authority.read(key, checkpoints.parse) ?? {};
  const save = (checkpoint: Checkpoint) =>
    authority.mutate(
      key,
      {},
      (raw) => ({
        value: { ...checkpoints.parse(raw), [checkpoint.identity]: checkpoint },
        result: undefined,
      }),
      checkpoints.parse,
    );
  const verifiedStopped = (entry: Checkpoint) => {
    // Binding is persisted before spawn. A reservation without a binding never dispatched.
    if (!entry.executionId) return entry.status === "running";
    const metadata = store.readProcessExecution(cardId, entry.executionId, "process-executions");
    return (
      z
        .object({
          executionId: z.literal(entry.executionId),
          cwd: z.literal(options.worktreePath),
          command: z.string().startsWith("opencode run"),
        })
        .safeParse(metadata).success &&
      z
        .union([
          z.object({ status: z.literal("not-dispatched") }),
          z.object({
            status: z.enum([
              "success",
              "nonzero",
              "timeout",
              "interrupted",
              "evidence-failure",
              "spawn-failure",
            ]),
            treeStopped: z.literal(true),
          }),
        ])
        .safeParse(metadata).success
    );
  };
  let active: Checkpoint | undefined;
  let deferred = false;
  const defer = () => {
    deferred = true;
    throw new FeedbackClassificationError("execution-uncertain");
  };
  return {
    get deferred() {
      return deferred;
    },
    assertStopped() {
      for (const value of Object.values(read()))
        if (
          (value.status === "running" || value.classification === "execution-uncertain") &&
          !verifiedStopped(value)
        )
          defer();
    },
    selectRevisions(revisions: readonly string[]) {
      const records = Object.values(read());
      const cohorts = new Map<string, string[]>();
      for (const revision of revisions) {
        const related = records.filter(
          (item) => item.status !== "recovered" && item.revisions?.includes(revision),
        );
        if (
          related.some(
            (item) =>
              item.status === "blocked" || (item.retryAt && Date.now() < Date.parse(item.retryAt)),
          )
        )
          continue;
        const cohort = related
          .map((item) => item.identity)
          .sort()
          .join(":");
        cohorts.set(cohort, [...(cohorts.get(cohort) ?? []), revision]);
      }
      // A new revision has its own allowance, even when an old revision is due.
      return cohorts.get("") ?? cohorts.values().next().value ?? [];
    },
    reserve(revisions: readonly string[]) {
      const identity = createHash("sha256").update(JSON.stringify(revisions)).digest("hex");
      const all = Object.values(read());
      const previous = all.find((item) => item.identity === identity);
      const related = all.filter(
        (item) =>
          item.status !== "recovered" &&
          item.revisions?.some((revision) => revisions.includes(revision)),
      );
      if (
        previous?.status === "blocked" ||
        related.some((item) => item.retryAt && Date.now() < Date.parse(item.retryAt))
      )
        defer();
      active = {
        identity,
        revisions: [...revisions],
        since:
          previous?.status === "recovered"
            ? new Date().toISOString()
            : (previous?.since ?? new Date().toISOString()),
        status: "running",
        failures: Math.max(previous?.failures ?? 0, ...related.map((item) => item.failures)) + 1,
        outages: Math.max(previous?.outages ?? 0, ...related.map((item) => item.outages)),
        retryAt: null,
        ...(previous?.attentionPrepared === undefined
          ? {}
          : { attentionPrepared: previous.attentionPrepared }),
      };
      if (active.failures > OPERATION_RECOVERY_MAX_EXECUTIONS) {
        save({ ...active, status: "blocked", classification: "execution-budget-exhausted" });
        defer();
      }
      save(active);
    },
    bind({ executionId }: { executionId: string }) {
      if (!active) throw new Error("Feedback classification dispatch lacks a durable reservation");
      active = { ...active, executionId };
      save(active);
    },
    complete() {
      if (!active) return;
      save({ ...active, status: "recovered", failures: 0, outages: 0, retryAt: null });
      if (active.failures > 1 || active.outages > 0)
        log.event(
          `Human feedback classification recovered for ${pullRequestUrl}; attempt ${authority.store.attemptId}`,
        );
    },
    async fail(error: FeedbackClassificationError) {
      if (!active || deferred) return;
      const { classification } = error;
      const transient = classification === "provider-unavailable" || classification === "cancelled";
      const failures = active.failures - (transient ? 1 : 0);
      const outages = active.outages + (classification === "provider-unavailable" ? 1 : 0);
      const blocked =
        classification === "configuration" || failures >= OPERATION_RECOVERY_MAX_EXECUTIONS;
      const retryAt = blocked
        ? null
        : new Date(
            Date.now() +
              Math.min(300_000, 15_000 * 2 ** Math.min(5, Math.max(failures, outages) - 1)),
          ).toISOString();
      const outcome = {
        ...active,
        classification,
        failures,
        outages,
        status: blocked ? ("blocked" as const) : ("waiting" as const),
        retryAt,
      };
      save(outcome);
      if (classification === "cancelled") return;
      const handlingOutcome = blocked
        ? "classification blocked; original PR and feedback retained"
        : `classification recovery wait until ${retryAt}; original PR and feedback retained`;
      if (failures + outages === 1 || blocked)
        log.warn(
          `${error.message}; PR ${pullRequestUrl}; attempt ${authority.store.attemptId}; ${handlingOutcome}`,
        );
      if (
        !outcome.attentionPrepared &&
        (blocked || failures + outages >= OPERATION_RECOVERY_MAX_EXECUTIONS)
      ) {
        await notifyAttentionRequired(
          options.emailNotifier,
          {
            project,
            cardIds: [cardId],
            category: "human-feedback-classification",
            reason: `${pullRequestUrl}; attempt ${authority.store.attemptId}; ${error.message}`,
            handlingOutcome,
            eventId: `feedback-classification:${authority.store.attemptId}:${active.identity}:${active.since}`,
          },
          log,
        );
        save({ ...outcome, attentionPrepared: true });
      }
    },
  };
}
