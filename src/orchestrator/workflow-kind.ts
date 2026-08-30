import type { ProjectConfig } from "../config/config.js";
import type { TrelloCard } from "../trello/trello-client.js";

export type WorkflowKind = "implementation" | "refinement";

export function getWorkflowKind(
  card: TrelloCard,
  project: ProjectConfig,
): WorkflowKind | null {
  if (card.idLabels.includes(project.trello.refinementLabelId)) {
    return "refinement";
  }

  const implementationLabelIds = new Set([
    project.trello.featureLabelId,
    project.trello.improvementLabelId,
    project.trello.bugLabelId,
  ]);

  return card.idLabels.some((labelId) => implementationLabelIds.has(labelId))
    ? "implementation"
    : null;
}
