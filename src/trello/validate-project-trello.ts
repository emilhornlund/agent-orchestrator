import type { Config } from "../config/config.js";
import { TrelloRequestError, type TrelloClient } from "./trello-client.js";
import { ProjectResourceError } from "../startup/project-resource-error.js";

type Project = Config["projects"][number];

export async function validateProjectTrello(
  trello: TrelloClient,
  project: Project,
): Promise<void> {
  let board: Awaited<ReturnType<TrelloClient["getBoard"]>>;
  let lists: Awaited<ReturnType<TrelloClient["getLists"]>>;
  let labels: Awaited<ReturnType<TrelloClient["getLabels"]>>;
  try {
    board = await trello.getBoard(project.trello.boardId);
    lists = await trello.getLists(project.trello.boardId);
    labels = await trello.getLabels(project.trello.boardId);
  } catch (error) {
    if (error instanceof TrelloRequestError && error.retryable) throw error;
    const transient =
      error instanceof TypeError &&
      /fetch|network|socket|connect/i.test(error.message);
    throw new ProjectResourceError(
      transient ? "unavailable" : "invalid",
      `Trello resource validation failed for project "${project.id}"${transient ? "; temporarily unavailable, retrying before processing" : "; verify board identity and credentials"}`,
      error,
    );
  }

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
      throw new ProjectResourceError(
        "invalid",
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
      throw new ProjectResourceError(
        "invalid",
        `Project "${project.id}" has invalid Trello ${name}: ${labelId} does not exist on board "${board.name}"`,
      );
    }
  }
}
