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
    ["doneListId", project.trello.doneListId],
  ] as const;

  for (const [name, listId] of requiredLists) {
    if (!listIds.has(listId)) {
      throw new Error(
        `Project "${project.id}" has invalid Trello ${name}: ${listId} does not exist on board "${board.name}"`,
      );
    }
  }
}
