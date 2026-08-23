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
    expect(String(requestUrl)).toContain("pos=top");
    expect(requestOptions).toEqual({
      method: "PUT",
    });
  });

  it("moves a card and marks it complete", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "card-1",
          name: "Implement inventory",
          desc: "Add inventory support",
          idList: "done-list",
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

    await client.moveCard("card-1", "done-list", {
      dueComplete: true,
    });

    expect(fetchMock).toHaveBeenCalledOnce();

    const [requestUrl, requestOptions] = fetchMock.mock.calls[0] ?? [];
    const url = new URL(String(requestUrl));

    expect(url.pathname).toBe("/1/cards/card-1");
    expect(url.searchParams.get("idList")).toBe("done-list");
    expect(url.searchParams.get("pos")).toBe("top");
    expect(url.searchParams.get("dueComplete")).toBe("true");

    expect(requestOptions).toEqual({
      method: "PUT",
    });
  });

  it("adds a comment to a card", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "action-1",
          type: "commentCard",
          date: "2026-08-22T09:00:00.000Z",
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

    const action = await client.addComment(
      "card-1",
      "Pull request: https://github.com/example/repository/pull/123",
    );

    expect(action).toEqual({
      id: "action-1",
      type: "commentCard",
      date: "2026-08-22T09:00:00.000Z",
    });

    expect(fetchMock).toHaveBeenCalledOnce();

    const [requestUrl, requestOptions] = fetchMock.mock.calls[0] ?? [];
    const url = new URL(String(requestUrl));

    expect(url.pathname).toBe("/1/cards/card-1/actions/comments");
    expect(url.searchParams.get("key")).toBe("test-key");
    expect(url.searchParams.get("token")).toBe("test-token");
    expect(url.searchParams.get("text")).toBe(
      "Pull request: https://github.com/example/repository/pull/123",
    );
    expect(requestOptions).toEqual({
      method: "POST",
    });
  });
});
