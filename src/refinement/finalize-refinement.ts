import type { ProjectConfig } from "../config/config.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { sanitizeControlledText } from "../security/redact-secrets.js";
import {
  TrelloRequestAbortedError,
  type TrelloCard,
  type TrelloClient,
} from "../trello/trello-client.js";

import type { RefinementResult } from "./refinement-result.js";

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
): Promise<void> {
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
    if (!prior)
      authority.mutate(
        refinementMutationSnapshotKey,
        null,
        () => ({ value: snapshot, result: undefined }),
        refinementMutationSnapshotSchema.parse,
      );
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

  await trello.moveCard(card.id, project.trello.backlogListId);
}
