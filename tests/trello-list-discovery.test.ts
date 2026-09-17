import { describe, expect, it, vi } from "vitest";

import {
  getCardsForDiscovery,
  TrelloListDiscoveryError,
} from "../src/orchestrator/trello-list-discovery.js";
import {
  TrelloRequestError,
  type TrelloClient,
} from "../src/trello/trello-client.js";

describe("getCardsForDiscovery", () => {
  it("keeps non-retryable list failures on the normal escalation path", async () => {
    const failure = new TrelloRequestError(
      "card lookup",
      "Trello request failed: 404 Not Found",
      { status: 404 },
    );
    const trello = {
      getCards: vi.fn().mockRejectedValue(failure),
    } as unknown as TrelloClient;

    await expect(
      getCardsForDiscovery(
        trello,
        "project-a",
        "working-list",
        "Could not retrieve Working cards",
      ),
    ).rejects.toMatchObject({
      name: "WorkflowError",
      category: "Workflow",
      cause: failure,
      message:
        "Could not retrieve Working cards: Trello request failed: 404 Not Found",
    });
    expect(trello.getCards).toHaveBeenCalledOnce();
  });

  it("wraps exhausted retryable list failures as retryable discovery errors", async () => {
    const failure = new TrelloRequestError(
      "card lookup",
      "Trello request failed: 503 Unavailable",
      { status: 503, retryable: true },
    );
    const trello = {
      getCards: vi.fn().mockRejectedValue(failure),
    } as unknown as TrelloClient;

    const result = expect(
      getCardsForDiscovery(
        trello,
        "project-a",
        "working-list",
        "Could not retrieve Working cards",
      ),
    ).rejects.toBeInstanceOf(TrelloListDiscoveryError);

    await result;
    expect(trello.getCards).toHaveBeenCalledTimes(3);
  });
});
