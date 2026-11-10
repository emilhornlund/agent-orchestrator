import { z } from "zod";
import {
  durableMutationSchema,
  mutationProvenNotDelivered,
} from "./durable-mutation.js";

const identifier = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.trim() === value &&
      !value.includes("/") &&
      !value.includes("\\") &&
      !Array.from(value).some((character) => {
        const code = character.codePointAt(0);
        return (
          code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f))
        );
      }),
  );
const date = z.string().datetime();

export const runLifecycleStates = [
  "preparing",
  "ready",
  "planning",
  "implementation",
  "refinement",
  "validation",
  "review",
  "publication",
  "ci",
  "human-feedback",
  "human-review",
  "waiting",
  "done",
  "refined",
  "failed",
  "cancelled",
] as const;
export type RunLifecycleState = (typeof runLifecycleStates)[number];
export const runEventTypes = [
  "claim",
  "implementation-claimed",
  "refinement-claimed",
  "plan-approved",
  "implementation-completed",
  "validation-passed",
  "validation-reviewed",
  "validation-failed",
  "review-completed",
  "publication-completed",
  "ci-observed",
  "feedback-received",
  "human-review-entered",
  "implementation-correction",
  "feedback-ci-failed",
  "feedback-replies-published",
  "refinement-completed",
  "wait-entered",
  "wait-resumed",
  "merged",
  "closed-unmerged",
  "failed",
  "cancelled",
] as const;
export type RunEventType = (typeof runEventTypes)[number];

/** Exact (event, prior lifecycle) -> next lifecycle inventory; absent tuples are forbidden. */
type TransitionDestination = RunLifecycleState | readonly RunLifecycleState[];
export const runTransitionMatrix: Readonly<
  Partial<
    Record<
      RunEventType,
      Partial<Record<RunLifecycleState, TransitionDestination>>
    >
  >
> = {
  claim: { ready: "planning" },
  "implementation-claimed": { preparing: "planning" },
  "refinement-claimed": { preparing: "refinement" },
  "plan-approved": { planning: "implementation" },
  "implementation-completed": { implementation: "validation" },
  "validation-passed": { validation: "review" },
  "validation-reviewed": { validation: "review" },
  "validation-failed": { validation: "publication" },
  "review-completed": { review: "publication" },
  "publication-completed": { publication: "ci" },
  "ci-observed": { ci: "human-review" },
  "feedback-received": { "human-review": "implementation" },
  "human-review-entered": { "human-feedback": "human-review" },
  "implementation-correction": {
    validation: "implementation",
    review: "implementation",
    ci: "implementation",
    "human-review": "implementation",
    "human-feedback": "implementation",
  },
  "feedback-ci-failed": { "human-review": "ci" },
  "feedback-replies-published": { "human-review": "ci" },
  "refinement-completed": { refinement: "refined" },
  "wait-entered": {
    preparing: "waiting",
    refinement: "waiting",
    planning: "waiting",
    implementation: "waiting",
    validation: "waiting",
    review: "waiting",
    publication: "waiting",
    ci: "waiting",
    "human-feedback": "waiting",
    "human-review": "waiting",
  },
  "wait-resumed": {
    waiting: [
      "planning",
      "preparing",
      "implementation",
      "refinement",
      "validation",
      "review",
      "publication",
      "ci",
      "human-feedback",
      "human-review",
    ],
  },
  merged: {
    planning: "done",
    implementation: "done",
    validation: "done",
    review: "done",
    publication: "done",
    "human-review": "done",
    ci: "done",
    waiting: "done",
    "human-feedback": "done",
  },
  "closed-unmerged": {
    planning: "cancelled",
    implementation: "cancelled",
    validation: "cancelled",
    review: "cancelled",
    publication: "cancelled",
    "human-review": "cancelled",
    ci: "cancelled",
    waiting: "cancelled",
    "human-feedback": "cancelled",
  },
  failed: {
    planning: "failed",
    refinement: "failed",
    implementation: "failed",
    validation: "failed",
    review: "failed",
    publication: "failed",
    // Failure is terminal only before a PR exists. Store-level checks enforce this.
    waiting: "failed",
  },
  cancelled: { "human-review": "cancelled", ci: "cancelled" },
};

export const pinnedIdentitySchema = z.strictObject({
  integrationId: z.string().min(1),
  projectId: identifier,
  boardId: identifier,
  lists: z.strictObject({
    ready: identifier,
    working: identifier,
    review: identifier,
    failed: identifier,
    done: identifier,
    backlog: identifier,
  }),
  repository: z.string().min(1),
  repositoryPath: z.string().min(1),
  worktreeRoot: z.string().min(1),
  storageRoot: z.string().min(1),
});
const artifactReference = z.strictObject({
  id: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  path: z.string().min(1),
  bytes: z.number().int().nonnegative().safe(),
  mediaType: z.string().min(1).optional(),
});
const operation = z.strictObject({
  mutation: durableMutationSchema.optional(),
  id: identifier,
  kind: identifier,
  status: z.enum([
    "pending",
    "running",
    "ambiguous",
    "completed",
    "failed",
    "cancelled",
  ]),
  generation: z.number().int().positive().safe(),
  expectedRevision: z.number().int().positive().safe(),
  prerequisites: z.array(identifier),
  intent: z.unknown(),
  completionEvidence: z.string().min(1).optional(),
  resolutionEvidence: z
    .discriminatedUnion("disposition", [
      z.strictObject({
        disposition: z.literal("accepted"),
        source: z.enum(["trello", "github", "git", "opencode", "process"]),
        observationId: identifier,
        observedAt: date,
      }),
      z.strictObject({
        disposition: z.literal("conclusively-not-accepted"),
        source: z.enum(["trello", "github", "git", "opencode", "process"]),
        observationId: identifier,
        observedAt: date,
        reason: z.enum(["provider-rejected", "not-dispatched"]),
      }),
      z.strictObject({
        disposition: z.literal("not-found"),
        source: z.enum(["trello", "github", "git", "opencode", "process"]),
        observationId: identifier,
        observedAt: date,
      }),
      z.strictObject({
        disposition: z.literal("uncertain"),
        source: z.enum(["trello", "github", "git", "opencode", "process"]),
        observationId: identifier,
        observedAt: date,
      }),
    ])
    .optional(),
});
export const terminalEvidenceSchema = z.strictObject({
  prOutcome: z.enum([
    "merged",
    "closed-unmerged",
    "no-pr-failure",
    "refinement-completed",
  ]),
  prObservationId: identifier,
  prVerifiedAt: date,
  trelloListId: identifier,
  trelloObservationId: identifier,
  trelloVerifiedAt: date,
});
export const runRecordSchema = z
  .strictObject({
    version: z.literal(1),
    revision: z.number().int().positive().safe(),
    projectId: identifier,
    cardId: identifier,
    attemptId: identifier,
    taskKind: z
      .enum(["implementation", "refinement"])
      .default("implementation"),
    pinned: pinnedIdentitySchema,
    lifecycle: z.enum(runLifecycleStates),
    checkpoint: z.enum(runLifecycleStates),
    publicationState: z.enum([
      "none",
      "open",
      "merged",
      "closed-unmerged",
      "unknown",
    ]),
    operation: z.strictObject({
      id: identifier.nullable(),
      kind: identifier.nullable(),
      generation: z.number().int().nonnegative().safe(),
    }),
    wait: z.strictObject({
      reason: identifier.nullable(),
      dependency: identifier.nullable(),
      since: date.nullable(),
      retryAt: date.nullable(),
    }),
    owner: z.strictObject({
      instanceId: identifier,
      token: identifier,
      generation: z.number().int().positive().safe(),
    }),
    resources: z.array(
      z.strictObject({
        kind: identifier,
        id: identifier,
        path: z.string().min(1),
        provenance: identifier,
      }),
    ),
    pendingOperations: z.array(operation),
    queue: z.array(
      z.strictObject({
        id: identifier,
        kind: identifier,
        enqueuedAt: date,
        priority: z.number().int().nonnegative().safe(),
        payload: z.unknown(),
      }),
    ),
    budgets: z.record(
      identifier,
      z.strictObject({
        limit: z.number().int().nonnegative().safe(),
        used: z.number().int().nonnegative().safe(),
        episodeId: identifier,
        trigger: identifier,
      }),
    ),
    sessions: z.record(identifier, identifier),
    artifacts: z.array(artifactReference),
    expectedTrelloListId: identifier.nullable(),
    terminalSync: z.enum([
      "not-applicable",
      "pending",
      "verified",
      "ambiguous",
    ]),
    terminalEvidence: terminalEvidenceSchema.nullable(),
    legacy: z.record(identifier, z.unknown()),
    /** Validated legacy-store projections, owned by this attempt envelope. */
    compatibility: z.record(identifier, z.unknown()).default({}),
    updatedAt: date,
  })
  .superRefine((run, ctx) => {
    if (run.projectId !== run.pinned.projectId)
      ctx.addIssue({
        code: "custom",
        path: ["pinned", "projectId"],
        message: "Pinned project must match attempt identity",
      });
    for (const op of run.pendingOperations)
      if (op.expectedRevision > run.revision)
        ctx.addIssue({
          code: "custom",
          path: ["pendingOperations"],
          message:
            "Operation expected revision cannot be ahead of current revision",
        });
    for (const [index, op] of run.pendingOperations.entries()) {
      if (op.mutation) {
        if (
          op.mutation.cancellation &&
          (op.mutation.cancellation.ownerGeneration > run.owner.generation ||
            (op.mutation.cancellation.reason === "terminal-observed" &&
              !["done", "refined", "failed", "cancelled"].includes(
                run.lifecycle,
              )))
        )
          ctx.addIssue({
            code: "custom",
            path: ["pendingOperations", index],
            message:
              "Cancellation must retain authoritative terminal/owner provenance",
          });
        const refs = [
          op.mutation.intent.payloadId,
          ...op.mutation.dispatches.flatMap((entry) =>
            entry.response ? [entry.response.evidence.artifactId] : [],
          ),
          ...op.mutation.observations.map((entry) => entry.evidence.artifactId),
          ...(op.mutation.cancellation
            ? [op.mutation.cancellation.evidence.artifactId]
            : []),
        ];
        if (
          refs.some(
            (id) => !run.artifacts.some((artifact) => artifact.id === id),
          ) ||
          JSON.stringify(op.intent) !== JSON.stringify(op.mutation.intent)
        )
          ctx.addIssue({
            code: "custom",
            path: ["pendingOperations", index],
            message:
              "Mutation payload/evidence references and intent must agree",
          });
        const verified = op.mutation.observations.find(
          (entry) => entry.outcome === "verified",
        );
        const expectedStatus = op.mutation.cancellation
          ? "cancelled"
          : verified
            ? "completed"
            : mutationProvenNotDelivered(op.mutation)
              ? "failed"
              : op.mutation.dispatches.length
                ? "ambiguous"
                : "pending";
        if (
          op.status !== expectedStatus ||
          op.kind !== op.mutation.intent.kind ||
          op.resolutionEvidence !== undefined ||
          (op.mutation.cancellation && op.completionEvidence !== undefined) ||
          (verified &&
            op.completionEvidence !== verified.evidence.observationId) ||
          op.generation !== Math.max(1, op.mutation.dispatches.length)
        )
          ctx.addIssue({
            code: "custom",
            path: ["pendingOperations", index],
            message:
              "Mutation state must match durable dispatch/verification evidence",
          });
      }
      if (op.status === "cancelled" && !op.mutation?.cancellation)
        ctx.addIssue({
          code: "custom",
          path: ["pendingOperations", index],
          message:
            "Cancelled operation requires never-dispatched mutation cancellation evidence",
        });
      if (op.status === "completed" && op.completionEvidence === undefined)
        ctx.addIssue({
          code: "custom",
          path: ["pendingOperations", index, "completionEvidence"],
          message: "A completed operation requires completion evidence",
        });
      if (
        op.status === "failed" &&
        op.mutation === undefined &&
        op.resolutionEvidence?.disposition !== "conclusively-not-accepted"
      )
        ctx.addIssue({
          code: "custom",
          path: ["pendingOperations", index, "resolutionEvidence"],
          message:
            "A failed operation requires conclusive non-acceptance evidence",
        });
      if (
        op.resolutionEvidence &&
        ((op.resolutionEvidence.disposition === "accepted" &&
          op.status !== "completed") ||
          (op.resolutionEvidence.disposition === "conclusively-not-accepted" &&
            op.status !== "failed") ||
          (["not-found", "uncertain"].includes(
            op.resolutionEvidence.disposition,
          ) &&
            op.status !== "ambiguous"))
      )
        ctx.addIssue({
          code: "custom",
          path: ["pendingOperations", index, "resolutionEvidence"],
          message:
            "Discovered operation state must match its evidence disposition",
        });
    }
    const correlations = run.pendingOperations.flatMap((entry) =>
      entry.mutation ? [entry.mutation.intent.correlationId] : [],
    );
    if (new Set(correlations).size !== correlations.length)
      ctx.addIssue({
        code: "custom",
        path: ["pendingOperations"],
        message: "Mutation correlation identities must be unique",
      });
    if (
      new Set(run.pendingOperations.map((entry) => entry.id)).size !==
      run.pendingOperations.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["pendingOperations"],
        message: "Operation identities must be unique",
      });
    for (const budget of Object.values(run.budgets))
      if (budget.used > budget.limit)
        ctx.addIssue({
          code: "custom",
          path: ["budgets"],
          message: "Budget usage may not exceed its limit",
        });
    if (
      run.lifecycle === "waiting" &&
      (run.wait.reason === null || run.wait.since === null)
    )
      ctx.addIssue({
        code: "custom",
        path: ["wait"],
        message: "Waiting requires a reason and checkpoint time",
      });
    if (
      run.lifecycle === "waiting" &&
      ["waiting", "done", "refined", "failed", "cancelled"].includes(
        run.checkpoint,
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "Wait checkpoint must be resumable",
      });
    if (
      !["waiting", "done", "refined", "failed", "cancelled"].includes(
        run.lifecycle,
      ) &&
      run.lifecycle !== run.checkpoint
    )
      ctx.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "Active checkpoint must match lifecycle",
      });
    if (
      run.lifecycle !== "waiting" &&
      (run.wait.reason !== null ||
        run.wait.dependency !== null ||
        run.wait.since !== null ||
        run.wait.retryAt !== null)
    )
      ctx.addIssue({
        code: "custom",
        path: ["wait"],
        message: "Wait details only apply while waiting",
      });
    if (
      ["done", "refined", "failed", "cancelled"].includes(run.lifecycle) &&
      (run.terminalSync !== "verified" ||
        run.terminalEvidence === null ||
        run.expectedTrelloListId !== run.terminalEvidence.trelloListId)
    )
      ctx.addIssue({
        code: "custom",
        path: ["terminalSync"],
        message:
          "Terminal state requires verified external synchronization and evidence",
      });
    if (run.lifecycle === "failed" && run.publicationState !== "none")
      ctx.addIssue({
        code: "custom",
        path: ["publicationState"],
        message: "A published or uncertain PR cannot be terminally failed",
      });
    if (run.lifecycle === "done" && run.publicationState !== "merged")
      ctx.addIssue({
        code: "custom",
        path: ["publicationState"],
        message: "Done requires verified merged PR outcome",
      });
    if (
      run.lifecycle === "refined" &&
      (run.taskKind !== "refinement" ||
        run.publicationState !== "none" ||
        run.terminalEvidence?.prOutcome !== "refinement-completed")
    )
      ctx.addIssue({
        code: "custom",
        path: ["terminalEvidence"],
        message:
          "Refined requires a verified refinement completion, not PR closure",
      });
    if (
      run.terminalEvidence?.prOutcome === "refinement-completed" &&
      (run.taskKind !== "refinement" ||
        run.terminalEvidence.trelloListId !== run.pinned.lists.backlog)
    )
      ctx.addIssue({
        code: "custom",
        path: ["terminalEvidence"],
        message:
          "Refinement completion must verify Backlog for a refinement attempt",
      });
    if (
      run.lifecycle === "cancelled" &&
      run.publicationState !== "closed-unmerged"
    )
      ctx.addIssue({
        code: "custom",
        path: ["publicationState"],
        message: "Cancellation requires verified closed-unmerged outcome",
      });
    if (
      run.lifecycle === "waiting" &&
      (run.checkpoint === "waiting" ||
        ["done", "refined", "failed", "cancelled"].includes(run.checkpoint))
    )
      ctx.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "Checkpoint must be resumable and nonterminal",
      });
  });
export type RunRecord = z.infer<typeof runRecordSchema>;
export type RunOperation = z.infer<typeof operation>;
export function isConclusiveOperationResolution(op: RunOperation): boolean {
  if (op.mutation?.cancellation)
    return op.status === "cancelled" && op.mutation.dispatches.length === 0;
  if (op.mutation)
    return (
      op.status === "completed" ||
      (op.status === "failed" && mutationProvenNotDelivered(op.mutation))
    );
  return (
    (op.status === "completed" &&
      op.completionEvidence !== undefined &&
      (op.resolutionEvidence === undefined ||
        op.resolutionEvidence.disposition === "accepted")) ||
    (op.status === "failed" &&
      op.resolutionEvidence?.disposition === "conclusively-not-accepted")
  );
}
export function parseRunRecord(value: unknown): RunRecord {
  return runRecordSchema.parse(value);
}
