import type { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { sanitizeControlledText } from "../security/redact-secrets.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";
import {
  refinementMutationSnapshotKey,
  refinementMutationSnapshotSchema,
  type RefinementHistoryAction,
} from "./refinement-mutation-snapshot.js";
import { RefinementSetupAmbiguousError } from "./run-refinement-setup.js";
import { mutationProvenNotDelivered } from "../task-session/durable-mutation.js";
import type { RunRecord } from "../task-session/run-record.js";

type Snapshot = ReturnType<typeof refinementMutationSnapshotSchema.parse>;
type Fields = Snapshot["original"];
export function isAbandonedRefinementWrite(
  authority: ProjectRunAuthority,
  entry: RunRecord["pendingOperations"][number],
): boolean {
  if (
    !["trello-content", "trello-labels"].includes(entry.kind) ||
    entry.status !== "failed" ||
    !entry.mutation ||
    !mutationProvenNotDelivered(entry.mutation)
  )
    return false;
  return (
    authority
      .read(
        refinementMutationSnapshotKey,
        refinementMutationSnapshotSchema.parse,
      )
      ?.reconciliation?.abandonedMutationIds?.includes(entry.id) ?? false
  );
}
export const refinementCardFields = (card: TrelloCard): Fields => ({
  title: card.name,
  description: card.desc,
  labels: [...card.idLabels].sort(),
});
export const sameRefinementFields = (a: Fields, b: Fields): boolean =>
  a.title === b.title &&
  a.description === b.description &&
  JSON.stringify([...a.labels].sort()) === JSON.stringify([...b.labels].sort());
export function writeRefinementSnapshot(
  authority: ProjectRunAuthority,
  snapshot: Snapshot,
): void {
  authority.mutate(
    refinementMutationSnapshotKey,
    snapshot,
    () => ({ value: snapshot, result: undefined }),
    refinementMutationSnapshotSchema.parse,
  );
}

/** The guard also runs from the concrete client's journal readback on restart. */
export async function guardRefinementFields(
  trello: Pick<TrelloClient, "getCard" | "getRefinementHistory">,
  authority: ProjectRunAuthority,
  stage: "before" | "after" | "verify",
  change?:
    | { title: string; description: string }
    | { labelId: string; present: boolean },
): Promise<boolean> {
  const snapshot = authority.read(
    refinementMutationSnapshotKey,
    refinementMutationSnapshotSchema.parse,
  );
  if (!snapshot?.reconciliation)
    throw new RefinementSetupAmbiguousError(
      "Refinement lacks trustworthy field/history provenance; preserve legacy fields for reconciliation",
    );
  const state = snapshot.reconciliation;
  if (state.conflict) throw new RefinementSetupAmbiguousError(state.conflict);
  const fail = (reason: string, evidence: unknown): never => {
    state.conflict = reason;
    state.evidence = JSON.parse(
      sanitizeControlledText(JSON.stringify(evidence)),
    ) as unknown;
    writeRefinementSnapshot(authority, snapshot);
    throw new RefinementSetupAmbiguousError(reason);
  };
  const history = await trello.getRefinementHistory(snapshot.cardId);
  const card = await trello.getCard(snapshot.cardId);
  const fields = refinementCardFields(card);
  if (history.actorId !== state.actorId || card.id !== snapshot.cardId)
    return fail(
      "Refinement actor/card attribution changed; operator reconciliation required",
      { history, card },
    );
  const boundary =
    state.cursor === null
      ? history.actions.length
      : history.actions.findIndex((a) => a.id === state.cursor);
  if (boundary < 0 || (state.cursor === null && history.actions.length >= 1000))
    return fail(
      "Refinement history continuity is unavailable; preserving current fields",
      { history, card },
    );
  const actions = history.actions.slice(0, boundary).reverse();
  if (stage === "before" || stage === "verify") {
    const exhausted =
      stage === "before"
        ? authority.store
            .read()!
            .pendingOperations.find(
              (entry) =>
                ["trello-content", "trello-labels"].includes(entry.kind) &&
                entry.status === "failed" &&
                !isAbandonedRefinementWrite(authority, entry) &&
                entry.mutation &&
                mutationProvenNotDelivered(entry.mutation) &&
                entry.mutation.dispatches.filter(
                  (dispatch) => dispatch.response?.outcome === "not-delivered",
                ).length >= 3,
            )
        : undefined;
    if (exhausted) {
      if (actions.length || !sameRefinementFields(fields, state.verified))
        return fail(
          "Rejected refinement write conflicts with current human fields/history; restoration is paused",
          { history, card },
        );
      if (state.mode === "restoring")
        return fail(
          "Refinement restoration was rejected three times; preserve verified partial fields for operator reconciliation",
          { history, card },
        );
      state.mode = "restoring";
      state.abandonedMutationIds = [
        ...(state.abandonedMutationIds ?? []),
        exhausted.id,
      ];
      delete state.pending;
      writeRefinementSnapshot(authority, snapshot);
      throw new RefinementSetupAmbiguousError(
        "Bounded field rejection is verified; restoring only attributable own changes on the next recovery pass",
      );
    }
    if (
      (stage === "verify" && state.pending) ||
      actions.length ||
      !sameRefinementFields(fields, state.verified)
    )
      return fail(
        "Refinement fields/history changed outside verified writes; preserving human content",
        { history, card },
      );
    if (stage === "verify") return true;
    if (!change) throw new Error("Refinement write has no intended change");
    const after: Fields =
      "labelId" in change
        ? {
            ...state.verified,
            labels: change.present
              ? [...new Set([...state.verified.labels, change.labelId])]
              : state.verified.labels.filter((id) => id !== change.labelId),
          }
        : {
            ...state.verified,
            title: change.title,
            description: change.description,
          };
    if (state.pending && !sameRefinementFields(state.pending, after))
      return fail(
        "Refinement pending write differs from immutable intended fields",
        { history, card },
      );
    state.pending = after;
    writeRefinementSnapshot(authority, snapshot);
    return true;
  }
  // A crash after this guard but before journal completion rechecks the verified
  // state; it never authorizes replaying the already accepted write.
  if (!state.pending) {
    if (actions.length || !sameRefinementFields(fields, state.verified))
      return fail("Verified refinement fields changed during reconciliation", {
        history,
        card,
      });
    return true;
  }
  const target = state.pending;
  const expected = { ...state.verified, labels: [...state.verified.labels] };
  const touched = new Set<string>();
  const apply = (action: RefinementHistoryAction): boolean => {
    if (
      action.idMemberCreator !== state.actorId ||
      action.data.card.id !== snapshot.cardId
    )
      return false;
    if (action.type === "updateCard") {
      if (
        !action.data.old ||
        (!Object.hasOwn(action.data.old, "name") &&
          !Object.hasOwn(action.data.old, "desc"))
      )
        return false;
      for (const [remote, local] of [
        ["name", "title"],
        ["desc", "description"],
      ] as const) {
        const old = action.data.old[remote];
        if (old === undefined) continue;
        if (
          touched.has(local) ||
          old !== expected[local] ||
          action.data.card[remote] !== target[local] ||
          expected[local] === target[local]
        )
          return false;
        touched.add(local);
        expected[local] = target[local];
      }
      return true;
    }
    const label = action.data.label?.id;
    if (!label || touched.has(label)) return false;
    const present = action.type === "addLabelToCard";
    if (
      expected.labels.includes(label) === present ||
      target.labels.includes(label) !== present
    )
      return false;
    touched.add(label);
    expected.labels = present
      ? [...expected.labels, label]
      : expected.labels.filter((id) => id !== label);
    return true;
  };
  if (!actions.every(apply))
    return fail(
      "Concurrent or unattributable refinement edits detected; recoverable human history preserved",
      { history, card },
    );
  if (!sameRefinementFields(fields, target)) {
    // No history/target readback yet is not evidence of non-acceptance.
    if (sameRefinementFields(fields, state.verified)) return false;
    return fail("Refinement write readback conflicts with intended fields", {
      history,
      card,
    });
  }
  if (!sameRefinementFields(expected, target)) return false;
  state.verified = target;
  state.cursor = history.actions[0]?.id ?? state.cursor;
  delete state.pending;
  writeRefinementSnapshot(authority, snapshot);
  return true;
}
