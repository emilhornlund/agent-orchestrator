import { z } from "zod";

const identity = z
  .string()
  .min(1)
  .max(512)
  .regex(/^\S+$/u)
  .refine(
    (value) =>
      !Array.from(value).some((character) => {
        const code = character.codePointAt(0)!;
        return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
      }),
  );
const date = z.string().datetime();
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

/** Concrete workflow effects, not executable commands or provider plugins. */
export const mutationPolicies = {
  "trello-move": "desired-state",
  "trello-content": "desired-state",
  "trello-labels": "desired-state",
  "trello-comment": "non-idempotent",
  "github-pr-create": "discoverable",
  "github-pr-body": "desired-state",
  "github-pr-draft": "desired-state",
  "github-reply": "non-idempotent",
  "git-commit": "discoverable",
  "git-push": "discoverable",
  "git-cleanup": "desired-state",
} as const;

export const mutationIntentSchema = z.strictObject({
  kind: z.enum(
    Object.keys(mutationPolicies) as [
      keyof typeof mutationPolicies,
      ...(keyof typeof mutationPolicies)[],
    ],
  ),
  /** Pinned service resource or refs; concrete reconcilers validate provenance. */
  target: identity,
  correlationId: identity,
  /** Exact sanitized outbound payload, stored as an immutable RunStore artifact. */
  payloadId: digest,
});
export type MutationIntent = z.infer<typeof mutationIntentSchema>;

const evidence = z.strictObject({
  observationId: identity,
  observedAt: date,
  /** Protected artifact containing authoritative fields/history, never raw log text. */
  artifactId: digest,
  nonDeliveryProof: z
    .enum(["provider-rejected-before-acceptance", "transport-proven-not-sent"])
    .optional(),
});
export const mutationEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("cancel"),
    reason: z.enum(["terminal-observed", "execution-superseded"]),
    evidence,
  }),
  z.strictObject({ type: z.literal("dispatch"), nextRecheckAt: date }),
  z.strictObject({
    type: z.literal("response"),
    outcome: z.enum(["accepted", "unknown", "not-delivered"]),
    evidence,
  }),
  z.strictObject({
    type: z.literal("observe"),
    outcome: z.enum(["verified", "absent", "uncertain", "not-delivered"]),
    evidence,
    resourceId: identity.optional(),
    nextRecheckAt: date.optional(),
    attentionRequired: z.boolean(),
  }),
]);
export type MutationEvent = z.infer<typeof mutationEventSchema>;

export const durableMutationSchema = z
  .strictObject({
    version: z.literal(1),
    intent: mutationIntentSchema,
    policy: z.enum(["desired-state", "discoverable", "non-idempotent"]),
    createdAt: date,
    executionFence: z.strictObject({
      id: identity.nullable(),
      generation: z.number().int().nonnegative().safe(),
    }),
    dispatches: z.array(
      z.strictObject({
        generation: z.number().int().positive().safe(),
        ownerGeneration: z.number().int().positive().safe(),
        dispatchedAt: date,
        response: z
          .strictObject({
            outcome: z.enum(["accepted", "unknown", "not-delivered"]),
            evidence,
          })
          .optional(),
      }),
    ),
    observations: z.array(
      z.strictObject({
        generation: z.number().int().positive().safe(),
        outcome: z.enum(["verified", "absent", "uncertain", "not-delivered"]),
        evidence,
        resourceId: identity.optional(),
      }),
    ),
    nextRecheckAt: date.nullable(),
    attentionRequired: z.boolean(),
    cancellation: z
      .strictObject({
        reason: z.enum(["terminal-observed", "execution-superseded"]),
        evidence,
        ownerGeneration: z.number().int().positive().safe(),
        recordedAt: date,
        executionFence: z.strictObject({
          id: identity.nullable(),
          generation: z.number().int().nonnegative().safe(),
        }),
      })
      .optional(),
  })
  .superRefine((mutation, ctx) => {
    if (
      mutation.cancellation &&
      (mutation.dispatches.length !== 0 ||
        mutation.observations.length !== 0 ||
        mutation.nextRecheckAt !== null ||
        mutation.attentionRequired ||
        mutation.cancellation.evidence.nonDeliveryProof !== undefined ||
        mutation.cancellation.evidence.observedAt < mutation.createdAt ||
        mutation.cancellation.evidence.observedAt >
          mutation.cancellation.recordedAt ||
        (mutation.cancellation.reason === "execution-superseded" &&
          mutation.cancellation.executionFence.id ===
            mutation.executionFence.id &&
          mutation.cancellation.executionFence.generation ===
            mutation.executionFence.generation))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Cancellation resolves only never-dispatched intent, not external outcomes",
      });
    const outcomes = [
      ...mutation.dispatches.flatMap((entry) =>
        entry.response ? [entry.response] : [],
      ),
      ...mutation.observations,
    ];
    if (
      outcomes.some(
        (entry) =>
          entry.outcome === "not-delivered" && !entry.evidence.nonDeliveryProof,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Non-delivery requires conclusive provider/transport proof",
      });
    if (mutation.policy !== mutationPolicies[mutation.intent.kind])
      ctx.addIssue({
        code: "custom",
        message: "Mutation policy does not match concrete kind",
      });
    for (const [index, dispatch] of mutation.dispatches.entries()) {
      if (dispatch.generation !== index + 1)
        ctx.addIssue({
          code: "custom",
          message: "Dispatch generations must be consecutive",
        });
      const prior = mutation.dispatches[index - 1];
      if (
        dispatch.dispatchedAt < mutation.createdAt ||
        (prior &&
          (dispatch.dispatchedAt < prior.dispatchedAt ||
            (prior.response?.outcome !== "not-delivered" &&
              !mutation.observations.some(
                (entry) =>
                  entry.generation === prior.generation &&
                  entry.outcome === "not-delivered",
              ))))
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Dispatch history must preserve intent ordering and prove previous non-delivery",
        });
      if (
        dispatch.response &&
        (dispatch.response.evidence.observedAt < dispatch.dispatchedAt ||
          (dispatch.response.outcome === "accepted" &&
            mutation.observations.some(
              (entry) =>
                entry.generation === dispatch.generation &&
                entry.outcome === "not-delivered",
            )))
      )
        ctx.addIssue({
          code: "custom",
          message: "Response contradicts dispatch/observation evidence",
        });
    }
    if (
      mutation.observations.some(
        (entry) => entry.generation > mutation.dispatches.length,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Observation requires a durable dispatch",
      });
    for (const observation of mutation.observations) {
      const dispatch = mutation.dispatches[observation.generation - 1];
      if (
        !dispatch ||
        observation.evidence.observedAt < dispatch.dispatchedAt ||
        (observation.outcome === "verified" &&
          (!observation.resourceId ||
            observation.generation !== mutation.dispatches.length ||
            dispatch.response?.outcome === "not-delivered" ||
            mutation.observations.some(
              (entry) =>
                entry.generation === observation.generation &&
                entry.outcome === "not-delivered",
            )))
      )
        ctx.addIssue({
          code: "custom",
          message: "Verification/observation contradicts dispatch history",
        });
    }
    if (
      mutation.observations.filter((entry) => entry.outcome === "verified")
        .length > 1
    )
      ctx.addIssue({
        code: "custom",
        message: "Completed mutation has one immutable verification",
      });
    if (
      mutation.dispatches.length &&
      !mutation.observations.some((entry) => entry.outcome === "verified") &&
      mutation.nextRecheckAt === null
    )
      ctx.addIssue({
        code: "custom",
        message: "Dispatched mutation requires a controlled recheck",
      });
  });
export type DurableMutation = z.infer<typeof durableMutationSchema>;

export function mutationProvenNotDelivered(mutation: DurableMutation): boolean {
  const dispatch = mutation.dispatches.at(-1);
  return (
    dispatch !== undefined &&
    (dispatch.response?.outcome === "not-delivered" ||
      mutation.observations.some(
        (entry) =>
          entry.generation === dispatch.generation &&
          entry.outcome === "not-delivered",
      ))
  );
}

/** Pure allowed-event reducer. Absence is NEVER proof of non-delivery. */
export function applyMutationEvent(
  mutation: DurableMutation,
  event: MutationEvent,
  ownerGeneration: number,
  now: string,
  executionFence?: { id: string | null; generation: number },
): DurableMutation {
  const next = structuredClone(mutation);
  const dispatch = next.dispatches.at(-1);
  if (next.cancellation) throw new Error("Cancelled mutation is immutable");
  if (event.type === "cancel") {
    if (!executionFence)
      throw new Error("Cancellation requires the current execution fence");
    if (next.dispatches.length !== 0 || next.observations.length !== 0)
      throw new Error("Cannot cancel a mutation after any durable dispatch");
    next.cancellation = {
      reason: event.reason,
      evidence: event.evidence,
      ownerGeneration,
      recordedAt: now,
      executionFence,
    };
    next.nextRecheckAt = null;
    next.attentionRequired = false;
    return durableMutationSchema.parse(next);
  }
  if (next.observations.some((entry) => entry.outcome === "verified"))
    throw new Error("Verified mutation is immutable");
  if (event.type === "dispatch") {
    if (event.nextRecheckAt <= now)
      throw new Error("Dispatch requires a future controlled recheck");
    if (dispatch && !mutationProvenNotDelivered(next))
      throw new Error("Possible acceptance requires discovery, not resend");
    if (next.nextRecheckAt && now < next.nextRecheckAt)
      throw new Error("Mutation recheck is not due");
    next.dispatches.push({
      generation: next.dispatches.length + 1,
      ownerGeneration,
      dispatchedAt: now,
    });
    next.nextRecheckAt = event.nextRecheckAt;
  } else {
    if (!dispatch) throw new Error("Outcome requires durable dispatch intent");
    if (event.outcome === "not-delivered" && !event.evidence.nonDeliveryProof)
      throw new Error(
        "Non-delivery requires conclusive provider/transport proof, not absence",
      );
    if (
      event.evidence.observedAt < dispatch.dispatchedAt ||
      event.evidence.observedAt > now
    )
      throw new Error(
        "Outcome evidence time is outside dispatch/recording interval",
      );
    if (event.type === "response") {
      if (dispatch.ownerGeneration !== ownerGeneration || dispatch.response)
        throw new Error("Stale or duplicate dispatch response");
      if (event.outcome === "accepted" && mutationProvenNotDelivered(next))
        throw new Error("Response contradicts conclusive non-delivery");
      dispatch.response = { outcome: event.outcome, evidence: event.evidence };
    } else {
      if (next.nextRecheckAt && now < next.nextRecheckAt)
        throw new Error("Mutation recheck is not due");
      if (
        ["absent", "uncertain"].includes(event.outcome) &&
        (!event.nextRecheckAt || event.nextRecheckAt <= now)
      )
        throw new Error("Uncertainty requires a future controlled recheck");
      if (event.outcome === "verified" && mutationProvenNotDelivered(next))
        throw new Error(
          "Contradictory acceptance after conclusive non-delivery",
        );
      if (
        event.outcome === "not-delivered" &&
        dispatch.response?.outcome === "accepted"
      )
        throw new Error("Accepted response cannot prove non-delivery");
      if (event.outcome === "verified" && !event.resourceId)
        throw new Error(
          "Verification must bind the actual resource/effect identity",
        );
      next.observations.push({
        generation: dispatch.generation,
        outcome: event.outcome,
        evidence: event.evidence,
        ...(event.resourceId ? { resourceId: event.resourceId } : {}),
      });
      next.nextRecheckAt =
        event.outcome === "verified"
          ? null
          : (event.nextRecheckAt ?? next.nextRecheckAt);
      next.attentionRequired = event.attentionRequired;
    }
  }
  return durableMutationSchema.parse(next);
}
