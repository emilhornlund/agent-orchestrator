import type { Config } from "../config/config.js";
import type { TrelloClient } from "./trello-client.js";

type Project = Config["projects"][number];

export async function validateProjectTrello(
  trello: TrelloClient,
  project: Project,
): Promise<void> {
  const board = await trello.getBoard(project.trello.boardId);
  const lists = await trello.getLists(project.trello.boardId);

  const listIds = new Set(lists.map((list) => list.id));

  const requiredLists = [
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
}
