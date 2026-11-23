import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProjectConfig } from "../config/config.js";
import { logger } from "../logging/logger.js";
import { notifyAttentionRequired, type EmailNotifier } from "../notifications/email-notifier.js";
import {
  classifyCurrentFeedback,
  FeedbackClassificationError,
  type FeedbackClassificationWait,
} from "./classify-current-feedback.js";
import type { OpenCodeClient } from "../opencode/opencode-client.js";
import { OPERATION_RECOVERY_MAX_EXECUTIONS } from "./operation-recovery-policy.js";
import { ProjectRunAuthority } from "./project-run-authority.js";
import { TaskExecutionStore } from "./task-execution-store.js";
import {
  processInventoryEntryStopped,
  readOwnedProcessInventory,
  journalProvesGitHubProcessNeverStarted,
} from "./owned-process-inventory.js";
import { startupStopProofForExecution } from "./startup-stop-attestation.js";
import { sanitizeControlledText } from "../security/redact-secrets.js";

const key = "feedback-classification-v1";
const checkpointSchema = z.strictObject({
  identity: z.string().regex(/^[a-f0-9]{64}$/u),
  revisions: z.array(z.string()).optional(),
  since: z.string().datetime(),
  status: z.enum(["running", "waiting", "blocked", "recovered", "probing"]),
  failures: z.number().int().nonnegative(),
  outages: z.number().int().nonnegative(),
  retryAt: z.string().datetime().nullable(),
  classification: z.string().optional(),
  executionId: z.uuid().optional(),
  attentionPrepared: z.boolean().optional(),
  probeFailures: z.number().int().nonnegative().optional(),
  probeSawFailure: z.boolean().optional(),
  recoveryEpisodeUsed: z.boolean().optional(),
  recoveryConfiguration: z.string().optional(),
  resultLedgerRevision: z.number().int().positive().optional(),
});
type Checkpoint = z.infer<typeof checkpointSchema>;
const checkpoints = z.record(z.string().regex(/^[a-f0-9]{64}$/u), checkpointSchema);
const stateSchema = z.union([
  z.strictObject({
    version: z.literal(2),
    active: checkpoints,
    archiveHead: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .nullable(),
  }),
  checkpoints.transform((active) => ({ version: 2 as const, active, archiveHead: null })),
]);
const probeMinimumMs = 5 * 60_000;

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
  const read = () => authority.read(key, stateSchema.parse)?.active ?? {};
  const save = (
    checkpoint: Checkpoint,
    retainHistory = false,
    completedRevisions?: readonly string[],
  ) =>
    authority.mutate(
      key,
      {},
      (raw) => {
        const state = stateSchema.parse(raw);
        const next = { ...state.active, [checkpoint.identity]: checkpoint };
        const archived: Checkpoint[] = retainHistory ? [checkpoint] : [];
        for (const [identity, row] of Object.entries(next)) {
          if (row.status === "recovered") {
            if (!archived.includes(row)) archived.push(row);
            delete next[identity];
          } else if (
            identity !== checkpoint.identity &&
            completedRevisions &&
            row.revisions?.some((revision) => completedRevisions.includes(revision))
          ) {
            archived.push(row);
            const remaining = row.revisions.filter(
              (revision) => !completedRevisions.includes(revision),
            );
            if (remaining.length > 0) next[identity] = { ...row, revisions: remaining };
            else delete next[identity];
          }
        }
        const archiveHead =
          archived.length === 0
            ? state.archiveHead
            : authority.store.writeArtifact(
                Buffer.from(
                  JSON.stringify({
                    version: 1,
                    kind: "feedback-classification-history",
                    previous: state.archiveHead,
                    entries: archived,
                  }),
                ),
                "application/json",
              ).id;
        return { value: { version: 2, active: next, archiveHead }, result: undefined };
      },
      stateSchema.parse,
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
  const checkpoint = {
    get deferred() {
      return deferred;
    },
    assertStopped(): FeedbackClassificationWait | undefined {
      const states = Object.values(read());
      const legacyCompleted = states.find((row) => row.status === "recovered");
      if (legacyCompleted) save(legacyCompleted);
      for (const value of states) {
        const waitForStop = () => {
          const retryAt =
            value.retryAt && Date.now() < Date.parse(value.retryAt)
              ? value.retryAt
              : new Date(Date.now() + 60_000).toISOString();
          if (retryAt !== value.retryAt) save({ ...value, retryAt });
          return {
            status: "blocked" as const,
            reason: "Feedback classification awaits verified process termination",
            retryAt,
          };
        };
        if (value.status === "probing") {
          if (value.executionId && !verifiedStopped(value)) return waitForStop();
          save({
            ...value,
            status: "blocked",
            retryAt: new Date(Date.now() + probeMinimumMs).toISOString(),
          });
          continue;
        }
        if (value.status === "running" && !value.executionId) {
          // The classifier binds process evidence before spawn. A restart in
          // the capacity queue cannot consume a genuine execution allowance.
          save({
            ...value,
            status: "waiting",
            failures: Math.max(0, value.failures - 1),
            retryAt: null,
          });
          continue;
        }
        if (
          (value.status === "running" || value.classification === "execution-uncertain") &&
          !verifiedStopped(value)
        )
          return waitForStop();
      }
      return undefined;
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
    async selectWithRecovery(
      revisions: readonly string[],
      openCode: OpenCodeClient,
      signal: AbortSignal,
    ): Promise<readonly string[] | FeedbackClassificationWait> {
      // Older releases logged a classifier error without writing a projection.
      // Treat their idle checkpoint as a recovery boundary before first dispatch.
      if (!authority.read(key, stateSchema.parse)) {
        const waitKey = "feedback-classification-legacy-process-wait";
        const waitSchema = z.strictObject({
          status: z.literal("blocked"),
          reason: z.string(),
          retryAt: z.string().datetime(),
          taskWide: z.literal(true).optional(),
        });
        const previous = authority.read(waitKey, waitSchema.parse);
        if (revisions.length === 0 && !previous) return [];
        if (previous && Date.now() < Date.parse(previous.retryAt))
          return { ...previous, taskWide: true };
        try {
          const task = store.read(cardId);
          if (!task) throw new Error("Missing owned task projection");
          const inventory = readOwnedProcessInventory(store, cardId);
          const bound = [
            task.setup?.executionId,
            task.sessionCreationExecutionId,
            ...Object.values(task.primaryOperations ?? {}).map(
              (operation) => operation.processExecutionId,
            ),
          ].filter((id): id is string => id !== undefined);
          if (bound.some((id) => !inventory.has(id)))
            throw new Error("Missing bound process evidence");
          for (const { file, metadata } of inventory.values())
            if (
              !processInventoryEntryStopped(metadata) &&
              !journalProvesGitHubProcessNeverStarted(authority, metadata) &&
              !startupStopProofForExecution({ authority, task, file, metadata, adopt: false })
            )
              throw new Error("A retained execution has no verified stopped outcome");
          if (previous) authority.remove(waitKey);
        } catch (error) {
          const reason = sanitizeControlledText(
            error instanceof Error ? error.message : "Unverified process evidence",
          ).slice(0, 2000);
          const wait = {
            status: "blocked" as const,
            reason,
            retryAt: new Date(Date.now() + 60_000).toISOString(),
            taskWide: true as const,
          };
          authority.mutate(
            waitKey,
            wait,
            () => ({ value: wait, result: undefined }),
            waitSchema.parse,
          );
          if (reason !== previous?.reason)
            log.warn(
              `Published feedback awaits safe process recovery for ${pullRequestUrl}: ${reason}`,
            );
          return wait;
        }
      }
      const selected = checkpoint.selectRevisions(revisions);
      if (selected.length) return selected;
      const relevant = Object.values(read()).filter((row) =>
        row.revisions?.some((revision) => revisions.includes(revision)),
      );
      const due = relevant.find(
        (row) =>
          row.status === "blocked" &&
          (row.retryAt === null || Date.now() >= Date.parse(row.retryAt)),
      );
      if (due) {
        const configuration = createHash("sha256")
          .update(JSON.stringify(project.opencode.review))
          .digest("hex");
        let probing: Checkpoint = {
          ...due,
          status: "probing",
          executionId: undefined,
          retryAt: new Date(Date.now() + probeMinimumMs).toISOString(),
        };
        save(probing);
        let healthy = false;
        let interrupted = false;
        try {
          const result = await classifyCurrentFeedback({
            project: {
              ...project,
              opencode: {
                ...project.opencode,
                timeoutMinutes: Math.min(1, project.opencode.timeoutMinutes),
              },
            },
            worktreePath: options.worktreePath,
            openCode,
            signal,
            singleExecution: true,
            incoming: [
              {
                kind: "review",
                id: "dependency-probe",
                author: "health-probe",
                body: "Thanks for the explanation.",
                createdAt: "2000-01-01T00:00:00.000Z",
                updatedAt: null,
                actionability: "unclassified",
                status: "pending",
                verificationEvidence: [],
              },
            ],
            previous: [],
            onExecutionPrepared({ executionId }) {
              probing = { ...probing, executionId };
              save(probing);
            },
          });
          healthy =
            result.length === 1 &&
            ["discussion", "not-actionable"].includes(result[0]!.actionability);
        } catch (error) {
          if (!(error instanceof FeedbackClassificationError)) throw error;
          interrupted = error.classification === "cancelled";
          if (
            error.classification === "execution-uncertain" &&
            probing.executionId &&
            !verifiedStopped(probing)
          )
            return {
              status: "blocked",
              reason: "Classification recovery probe lacks stopped-process evidence",
              retryAt: probing.retryAt,
            };
        }
        if (
          healthy &&
          (!due.recoveryEpisodeUsed ||
            due.probeSawFailure ||
            due.recoveryConfiguration !== configuration)
        ) {
          save(
            {
              ...probing,
              status: "waiting",
              classification: undefined,
              failures: 0,
              outages: 0,
              retryAt: null,
              recoveryEpisodeUsed: true,
              probeSawFailure: false,
              probeFailures: 0,
              recoveryConfiguration: configuration,
            },
            true,
          );
          log.event(
            `Feedback classification dependency verified; resuming the original requests for ${pullRequestUrl}`,
          );
          return checkpoint.selectRevisions(revisions);
        }
        const probeFailures = Math.min((due.probeFailures ?? 0) + (interrupted ? 0 : 1), 16);
        save({
          ...probing,
          status: "blocked",
          probeFailures,
          probeSawFailure: due.probeSawFailure === true || (!healthy && !interrupted),
          retryAt: new Date(
            Date.now() + Math.min(60 * 60_000, probeMinimumMs * 2 ** Math.min(probeFailures, 4)),
          ).toISOString(),
        });
      }
      const retained = Object.values(read()).filter((row) =>
        row.revisions?.some((revision) => revisions.includes(revision)),
      );
      return {
        status: retained.some((row) => row.status === "blocked" || row.status === "probing")
          ? "blocked"
          : "waiting",
        reason: retained.some((row) => row.status === "blocked")
          ? "Feedback retained until the classifier dependency probe verifies recovery"
          : "Feedback retained until the scheduled classification recheck",
        retryAt:
          retained
            .map((row) => row.retryAt)
            .filter((time): time is string => time !== null)
            .sort()[0] ?? null,
      };
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
        ...related.find((entry) => entry.recoveryEpisodeUsed),
        ...previous,
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
        classification: undefined,
        executionId: undefined,
        resultLedgerRevision: undefined,
        ...(previous?.attentionPrepared === undefined
          ? {}
          : { attentionPrepared: previous.attentionPrepared }),
      };
      if (active.failures > OPERATION_RECOVERY_MAX_EXECUTIONS) {
        save(
          {
            ...active,
            status: "blocked",
            classification: "execution-budget-exhausted",
            retryAt: new Date(Date.now() + probeMinimumMs).toISOString(),
          },
          true,
          revisions,
        );
        defer();
      }
      save(active, false, revisions);
    },
    bind({ executionId }: { executionId: string }) {
      if (!active) throw new Error("Feedback classification dispatch lacks a durable reservation");
      active = { ...active, executionId };
      save(active);
    },
    complete() {
      if (!active) return;
      save({ ...active, status: "recovered", retryAt: null }, true, active.revisions);
      if (active.failures > 1 || active.outages > 0)
        log.event(
          `Human feedback classification recovered for ${pullRequestUrl}; attempt ${authority.store.attemptId}`,
        );
    },
    prepareLedgerCommit(nextRevision: number) {
      if (!active) return;
      active = { ...active, resultLedgerRevision: nextRevision };
      save(active);
    },
    finishCommittedCheckpoints(ledgerRevision: number) {
      for (const row of Object.values(read()))
        if (
          row.status === "running" &&
          row.resultLedgerRevision !== undefined &&
          ledgerRevision >= row.resultLedgerRevision
        )
          save({ ...row, status: "recovered", retryAt: null }, true, row.revisions);
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
        ? new Date(Date.now() + probeMinimumMs).toISOString()
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
      save(outcome, true);
      if (classification === "cancelled") return;
      const handlingOutcome = blocked
        ? `classification blocked; original PR and feedback retained; dependency probe due at ${retryAt}`
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
  return checkpoint;
}
