import type { Config } from "../config/config.js";
import { prepareWorktree } from "../git/prepare-worktree.js";
import { logger } from "../logging/logger.js";
import type { GitClient } from "../git/git-client.js";
import { type TrelloCard, type TrelloClient } from "../trello/trello-client.js";

import { getWorkflowKind } from "./workflow-kind.js";

type Project = Config["projects"][number];

export interface ClaimedImplementationCard {
  card: TrelloCard;
  worktree: Awaited<ReturnType<typeof prepareWorktree>>;
}

export async function claimNextCard(
  trello: TrelloClient,
  git: GitClient,
  project: Project,
  signal?: AbortSignal,
): Promise<ClaimedImplementationCard | null> {
  if (signal?.aborted) {
    return null;
  }

  const cards = await trello.getCards(project.trello.readyListId);

  for (const candidate of cards) {
    if (signal?.aborted) {
      return null;
    }

    if (getWorkflowKind(candidate, project) !== "implementation") {
      continue;
    }

    const worktree = await prepareWorktree(git, project, candidate.id);

    if (signal?.aborted) {
      return null;
    }

    const claimedCard = await trello.moveCard(
      candidate.id,
      project.trello.workingListId,
    );

    logger
      .child({ projectId: project.id, cardId: candidate.id })
      .debug("Prepared worktree before moving card to Working");

    return {
      card: claimedCard,
      worktree,
    };
  }

  return null;
}
