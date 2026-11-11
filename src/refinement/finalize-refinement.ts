import type { ProjectConfig } from "../config/config.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { sanitizeControlledText } from "../security/redact-secrets.js";
import {
  TrelloRequestAbortedError,
  type TrelloCard,
  type TrelloClient,
} from "../trello/trello-client.js";

import {
  refinementResultSchema,
  type RefinementResult,
} from "./refinement-result.js";
import {
  guardRefinementFields,
  refinementCardFields,
  sameRefinementFields,
  writeRefinementSnapshot,
} from "./refinement-card-guard.js";
import {
  RefinementSetupAmbiguousError,
  RefinementSetupFailedError,
} from "./run-refinement-setup.js";
import { recordRefinementAnalysisFailure } from "./refinement-input.js";

import {
  refinementMutationSnapshotSchema,
  refinementMutationSnapshotKey,
} from "./refinement-mutation-snapshot.js";
export {
  refinementMutationSnapshotSchema,
  refinementMutationSnapshotKey,
} from "./refinement-mutation-snapshot.js";

function getClassificationLabelId(
  project: ProjectConfig,
  type: RefinementResult["type"],
): string {
  switch (type) {
    case "feature":
      return project.trello.featureLabelId;

    case "improvement":
      return project.trello.improvementLabelId;

    case "bug":
      return project.trello.bugLabelId;
  }
}

export async function finalizeRefinement(
  trello: TrelloClient,
  project: ProjectConfig,
  card: TrelloCard,
  result: RefinementResult,
  signal?: AbortSignal,
  beforeFinalMove?: () => void,
): Promise<void> {
  refinementResultSchema.parse(result);
  const classificationLabelId = getClassificationLabelId(project, result.type);

  const classificationLabelIds = [
    project.trello.featureLabelId,
    project.trello.improvementLabelId,
    project.trello.bugLabelId,
  ];
  const authority = ProjectRunAuthority.current(project.id);
  if (authority) {
    const snapshot = refinementMutationSnapshotSchema.parse({
      cardId: card.id,
      original: {
        title: sanitizeControlledText(card.name),
        description: sanitizeControlledText(card.desc),
        labels: card.idLabels,
      },
      intended: {
        title: sanitizeControlledText(result.title),
        description: sanitizeControlledText(result.description),
        type: result.type,
        labels: [
          ...card.idLabels.filter(
            (id) =>
              ![
                ...classificationLabelIds,
                project.trello.refinementLabelId,
              ].includes(id),
          ),
          classificationLabelId,
        ],
      },
    });
    const prior = authority.read(
      refinementMutationSnapshotKey,
      refinementMutationSnapshotSchema.parse,
    );
    if (
      prior &&
      JSON.stringify(prior.intended) !== JSON.stringify(snapshot.intended)
    )
      throw new Error(
        "Refinement intended result changed; preserve original fields for reconciliation",
      );
    if (!prior) {
      const history = await trello.getRefinementHistory(card.id);
      const current = await trello.getCard(card.id);
      const after = await trello.getRefinementHistory(card.id);
      if (
        !sameRefinementFields(
          refinementCardFields(current),
          snapshot.original,
        ) ||
        history.actorId !== after.actorId ||
        JSON.stringify(history.actions) !== JSON.stringify(after.actions)
      )
        throw new RefinementSetupAmbiguousError(
          "Card changed before refinement field baseline; preserve current human values",
        );
      snapshot.reconciliation = {
        actorId: history.actorId,
        cursor: history.actions[0]?.id ?? null,
        verified: snapshot.original,
      };
      writeRefinementSnapshot(authority, snapshot);
    }
    // Legacy snapshots have no trustworthy history/verified-own-write baseline.
    // The guard preserves them, including partially updated cards, without guessing.
    await guardRefinementFields(trello, authority, "verify");
    const read = () =>
      authority.read(
        refinementMutationSnapshotKey,
        refinementMutationSnapshotSchema.parse,
      )!;
    const restoring = ["restoring", "restored"].includes(
      read().reconciliation!.mode ?? "applying",
    );
    const desired = restoring ? read().original : read().intended;
    if (
      read().reconciliation!.verified.title !== desired.title ||
      read().reconciliation!.verified.description !== desired.description
    )
      await trello.updateCardContent(
        card.id,
        desired.title,
        desired.description,
      );
    for (const labelId of new Set([
      ...classificationLabelIds,
      project.trello.refinementLabelId,
      ...read().reconciliation!.verified.labels,
      ...desired.labels,
    ])) {
      signal?.throwIfAborted();
      const state = read();
      const present = desired.labels.includes(labelId);
      if (state.reconciliation!.verified.labels.includes(labelId) !== present) {
        if (present) await trello.addLabel(card.id, labelId);
        else await trello.removeLabel(card.id, labelId);
      }
    }
    await guardRefinementFields(trello, authority, "verify");
    if (!sameRefinementFields(read().reconciliation!.verified, desired))
      throw new RefinementSetupAmbiguousError(
        "Complete refinement fields are not verified; retain ownership",
      );
    if (restoring) {
      const restored = read();
      restored.reconciliation!.mode = "restored";
      writeRefinementSnapshot(authority, restored);
      recordRefinementAnalysisFailure(
        authority,
        "Refinement field update was conclusively rejected after bounded attempts; original title, description and classification were restored and verified without overwriting human edits",
      );
      throw new RefinementSetupFailedError(
        "Refinement could not complete; original fields are restored and verified",
      );
    }
    signal?.throwIfAborted();
    beforeFinalMove?.();
    await trello.moveCard(card.id, project.trello.backlogListId);
    await guardRefinementFields(trello, authority, "verify");
    return;
  }

  if (signal?.aborted) {
    throw new TrelloRequestAbortedError();
  }

  await trello.updateCardContent(card.id, result.title, result.description);

  for (const labelId of classificationLabelIds) {
    if (signal?.aborted) {
      throw new TrelloRequestAbortedError();
    }

    if (labelId !== classificationLabelId && card.idLabels.includes(labelId)) {
      await trello.removeLabel(card.id, labelId);
    }
  }

  if (signal?.aborted) {
    throw new TrelloRequestAbortedError();
  }

  if (!card.idLabels.includes(classificationLabelId)) {
    await trello.addLabel(card.id, classificationLabelId);
  }

  if (signal?.aborted) {
    throw new TrelloRequestAbortedError();
  }

  await trello.removeLabel(card.id, project.trello.refinementLabelId);

  if (signal?.aborted) {
    throw new TrelloRequestAbortedError();
  }

  beforeFinalMove?.();
  await trello.moveCard(card.id, project.trello.backlogListId);
}
