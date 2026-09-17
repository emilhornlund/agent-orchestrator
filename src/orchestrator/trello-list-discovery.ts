import {
  TrelloRequestAbortedError,
  isRetryableTrelloError,
  type TrelloCard,
  type TrelloClient,
} from "../trello/trello-client.js";

import { getRetryBackoffDelayMilliseconds } from "./retry-backoff.js";
import { trelloReconciliationError } from "./trello-reconciliation-error.js";

export const MAX_TRELLO_CARD_DISCOVERY_ATTEMPTS = 3;

export class TrelloListDiscoveryError extends Error {
  readonly projectId: string;
  readonly listId: string;
  readonly attempts: number;

  constructor(
    projectId: string,
    listId: string,
    attempts: number,
    message: string,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = "TrelloListDiscoveryError";
    this.projectId = projectId;
    this.listId = listId;
    this.attempts = attempts;
  }
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TrelloRequestAbortedError());
      return;
    }

    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, milliseconds);

    function handleAbort(): void {
      clearTimeout(timeout);
      reject(new TrelloRequestAbortedError());
    }

    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

export async function getCardsForDiscovery(
  trello: TrelloClient,
  projectId: string,
  listId: string,
  description: string,
  signal?: AbortSignal,
): Promise<TrelloCard[]> {
  let lastError: unknown;
  let attempts = 0;

  while (attempts < MAX_TRELLO_CARD_DISCOVERY_ATTEMPTS) {
    if (signal?.aborted) {
      throw new TrelloRequestAbortedError();
    }

    attempts += 1;

    try {
      return await trello.getCards(listId);
    } catch (error) {
      lastError = error;

      if (!isRetryableTrelloError(error)) {
        throw trelloReconciliationError(
          projectId,
          undefined,
          "card lookup",
          error,
          `${description}: ${error instanceof Error ? error.message : String(error)}`,
          { reconciliationListId: listId },
        );
      }

      if (attempts >= MAX_TRELLO_CARD_DISCOVERY_ATTEMPTS) {
        break;
      }

      await sleep(getRetryBackoffDelayMilliseconds(attempts), signal);
    }
  }

  throw new TrelloListDiscoveryError(
    projectId,
    listId,
    attempts,
    `${description}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    lastError,
  );
}
