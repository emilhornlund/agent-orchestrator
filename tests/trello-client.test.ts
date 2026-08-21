import { afterEach, describe, expect, it, vi } from "vitest";

import { TrelloClient } from "../src/trello/trello-client.js";

describe("TrelloClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gets a board", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "board-1",
          name: "rpg-sdl",
          url: "https://trello.com/b/example/rpg-sdl",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      ),
    );

    const client = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });

    const board = await client.getBoard("board-1");

    expect(board).toEqual({
      id: "board-1",
      name: "rpg-sdl",
      url: "https://trello.com/b/example/rpg-sdl",
    });
  });

  it("gets lists from a board", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "list-1",
            name: "Ready for Agent",
            closed: false,
          },
        ]),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      ),
    );

    const client = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });

    const lists = await client.getLists("board-1");

    expect(lists).toEqual([
      {
        id: "list-1",
        name: "Ready for Agent",
        closed: false,
      },
    ]);
  });

  it("gets cards from a list", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "card-1",
            name: "Implement inventory",
            desc: "Add inventory support",
            idList: "ready-list",
            url: "https://trello.com/c/example",
          },
        ]),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      ),
    );

    const client = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });

    const cards = await client.getCards("ready-list");

    expect(cards).toHaveLength(1);
    expect(cards[0]?.name).toBe("Implement inventory");
    expect(fetchMock).toHaveBeenCalledOnce();

    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);

    expect(requestUrl).toContain("/lists/ready-list/cards");
    expect(requestUrl).toContain("key=test-key");
    expect(requestUrl).toContain("token=test-token");
  });

  it("throws when Trello returns an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 401,
        statusText: "Unauthorized",
      }),
    );

    const client = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });

    await expect(client.getCards("ready-list")).rejects.toThrow(
      "Trello request failed: 401 Unauthorized",
    );
  });

  it("moves a card to another list", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "card-1",
          name: "Implement inventory",
          desc: "Add inventory support",
          idList: "working-list",
          url: "https://trello.com/c/example",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      ),
    );

    const client = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });

    const card = await client.moveCard("card-1", "working-list");

    expect(card.idList).toBe("working-list");
    expect(fetchMock).toHaveBeenCalledOnce();

    const [requestUrl, requestOptions] = fetchMock.mock.calls[0] ?? [];

    expect(String(requestUrl)).toContain("/cards/card-1");
    expect(String(requestUrl)).toContain("idList=working-list");
    expect(requestOptions).toEqual({
      method: "PUT",
    });
  });
});
