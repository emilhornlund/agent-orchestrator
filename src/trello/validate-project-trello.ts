import type { Config } from "../config/config.js";
import type { TrelloClient } from "./trello-client.js";

type Project = Config["projects"][number];

export async function validateProjectTrello(
  trello: TrelloClient,
  project: Project,
): Promise<void> {
  const board = await trello.getBoard(project.trello.boardId);
  const lists = await trello.getLists(project.trello.boardId);
  const labels = await trello.getLabels(project.trello.boardId);

  const listIds = new Set(lists.map((list) => list.id));

  const requiredLists = [
    ["backlogListId", project.trello.backlogListId],
    ["readyListId", project.trello.readyListId],
    ["workingListId", project.trello.workingListId],
    ["reviewListId", project.trello.reviewListId],
    ["failedListId", project.trello.failedListId],
    ["doneListId", project.trello.doneListId],
  ] as const;

  for (const [name, listId] of requiredLists) {
    const list = lists.find((candidate) => candidate.id === listId);

    if (!listIds.has(listId) || list?.closed) {
      throw new Error(
        `Project "${project.id}" has invalid Trello ${name}: ${listId} does not exist or is closed on board "${board.name}"`,
      );
    }
  }

  const labelIds = new Set(labels.map((label) => label.id));

  const requiredLabels = [
    ["refinementLabelId", project.trello.refinementLabelId],
    ["featureLabelId", project.trello.featureLabelId],
    ["improvementLabelId", project.trello.improvementLabelId],
    ["bugLabelId", project.trello.bugLabelId],
  ] as const;

  for (const [name, labelId] of requiredLabels) {
    if (!labelIds.has(labelId)) {
      throw new Error(
        `Project "${project.id}" has invalid Trello ${name}: ${labelId} does not exist on board "${board.name}"`,
      );
    }
  }

  const customFields = await trello.getCustomFields(project.trello.boardId);
  const ownershipCustomField = customFields.find(
    (field) => field.id === project.trello.ownershipCustomFieldId,
  );

  if (
    ownershipCustomField === undefined ||
    ownershipCustomField.type !== "text"
  ) {
    throw new Error(
      `Project "${project.id}" has invalid Trello ownershipCustomFieldId: ${project.trello.ownershipCustomFieldId} does not exist as a text custom field on board "${board.name}"`,
    );
  }
}
