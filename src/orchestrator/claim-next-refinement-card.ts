import type { Config } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import { prepareWorktree } from "../git/prepare-worktree.js";
import { logger } from "../logging/logger.js";
import { type TrelloCard, type TrelloClient } from "../trello/trello-client.js";

import { annotateCardFailure, annotateFailure } from "./failure-diagnostic.js";

type Project = Config["projects"][number];

export interface ClaimedRefinementCard {
  card: TrelloCard;
  worktree: Awaited<ReturnType<typeof prepareWorktree>>;
}

export async function claimNextRefinementCard(
  trello: TrelloClient,
  git: GitClient,
  project: Project,
  signal?: AbortSignal,
): Promise<ClaimedRefinementCard | null> {
  if (signal?.aborted) {
    return null;
  }

  let cards: TrelloCard[];

  try {
    cards = await trello.getCards(project.trello.readyListId);
  } catch (error) {
    if (error instanceof Error) {
      annotateFailure(error, { projectId: project.id });
    }

    throw error;
  }

  for (const candidate of cards) {
    if (signal?.aborted) {
      return null;
    }

    if (!candidate.idLabels.includes(project.trello.refinementLabelId)) {
      continue;
    }

    let worktree;

    try {
      worktree = await prepareWorktree(git, project, candidate.id);
    } catch (error) {
      if (error instanceof Error) {
        annotateCardFailure(error, project.id, candidate.id);
      }

      throw error;
    }

    if (signal?.aborted) {
      return null;
    }

    let claimedCard;

    try {
      claimedCard = await trello.moveCard(
        candidate.id,
        project.trello.workingListId,
      );
    } catch (error) {
      if (error instanceof Error) {
        annotateCardFailure(error, project.id, candidate.id);
      }

      throw error;
    }

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
