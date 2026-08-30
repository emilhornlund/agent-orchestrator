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

  it("gets labels from a board", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "feature-label",
            name: "Feature",
            color: "green",
          },
          {
            id: "bug-label",
            name: "Bug",
            color: "red",
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

    const labels = await client.getLabels("board-1");

    expect(labels).toEqual([
      {
        id: "feature-label",
        name: "Feature",
        color: "green",
      },
      {
        id: "bug-label",
        name: "Bug",
        color: "red",
      },
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();

    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);

    expect(requestUrl).toContain("/boards/board-1/labels");
    expect(requestUrl).toContain("key=test-key");
    expect(requestUrl).toContain("token=test-token");
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
            idLabels: ["refinement-label"],
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
    expect(cards[0]?.idLabels).toEqual(["refinement-label"]);
    expect(fetchMock).toHaveBeenCalledOnce();

    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);

    expect(requestUrl).toContain("/lists/ready-list/cards");
    expect(requestUrl).toContain("key=test-key");
    expect(requestUrl).toContain("token=test-token");
  });

  it("gets the latest list transition into a requested list", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "action-old",
            type: "updateCard",
            date: "2026-08-30T09:00:00.000Z",
            data: {
              listBefore: { id: "backlog-list", name: "Backlog" },
              listAfter: { id: "working-list", name: "Working" },
            },
          },
          {
            id: "action-new",
            type: "updateCard",
            date: "2026-08-30T10:00:00.000Z",
            data: {
              listBefore: { id: "ready-list", name: "Ready for Agent" },
              listAfter: { id: "working-list", name: "Working" },
            },
          },
        ]),
        { status: 200 },
      ),
    );
    const client = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });

    await expect(
      client.getLatestListTransition("card-1", "working-list"),
    ).resolves.toEqual({
      id: "action-new",
      date: "2026-08-30T10:00:00.000Z",
      listBeforeId: "ready-list",
      listAfterId: "working-list",
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/1/cards/card-1/actions");
    expect(url.searchParams.get("filter")).toBe("updateCard");
  });

  it("ignores card updates without list transitions", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "action-1",
            type: "updateCard",
            date: "2026-08-30T10:00:00.000Z",
            data: {},
          },
        ]),
        { status: 200 },
      ),
    );
    const client = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });

    await expect(
      client.getLatestListTransition("card-1", "working-list"),
    ).resolves.toBeNull();
  });

  it("rejects a malformed card response instead of returning unchecked data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{ id: "card-1", name: "Incomplete" }]), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }),
    );

    const client = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });

    await expect(client.getCards("ready-list")).rejects.toThrow();
  });

  it("rejects a non-array list response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "list-1" }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }),
    );

    const client = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });

    await expect(client.getLists("board-1")).rejects.toThrow();
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

  it("does not start a request when shutdown has already been requested", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const client = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
      signal: controller.signal,
      timeoutMilliseconds: 30_000,
    });

    await expect(client.getBoard("board-1")).rejects.toThrow(
      "Trello request aborted",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("converts an in-flight shutdown abort into a typed request error", async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        await new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });

        throw new Error("unreachable");
      });

    const client = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
      signal: controller.signal,
    });
    const request = client.getBoard("board-1");

    controller.abort();

    await expect(request).rejects.toThrow("Trello request aborted");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("moves a card to another list", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "card-1",
          name: "Implement inventory",
          desc: "Add inventory support",
          idList: "working-list",
          idLabels: [],
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
          idLabels: [],
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

  it("updates a card title and description", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "card-1",
          name: "Add inventory support",
          desc: "# Add inventory support\n\n## Description\n\nAdd inventory support.",
          idList: "working-list",
          idLabels: ["refinement-label"],
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

    const card = await client.updateCardContent(
      "card-1",
      "Add inventory support",
      "# Add inventory support\n\n## Description\n\nAdd inventory support.",
    );

    expect(card.name).toBe("Add inventory support");
    expect(card.desc).toBe(
      "# Add inventory support\n\n## Description\n\nAdd inventory support.",
    );

    expect(fetchMock).toHaveBeenCalledOnce();

    const [requestUrl, requestOptions] = fetchMock.mock.calls[0] ?? [];
    const url = new URL(String(requestUrl));

    expect(url.pathname).toBe("/1/cards/card-1");
    expect(url.searchParams.get("name")).toBe("Add inventory support");
    expect(url.searchParams.get("desc")).toBe(
      "# Add inventory support\n\n## Description\n\nAdd inventory support.",
    );

    expect(requestOptions).toEqual({
      method: "PUT",
    });
  });

  it("adds an existing label to a card", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 200,
      }),
    );

    const client = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });

    await client.addLabel("card-1", "refinement-label");

    expect(fetchMock).toHaveBeenCalledOnce();

    const [requestUrl, requestOptions] = fetchMock.mock.calls[0] ?? [];
    const url = new URL(String(requestUrl));

    expect(url.pathname).toBe("/1/cards/card-1/idLabels");
    expect(url.searchParams.get("key")).toBe("test-key");
    expect(url.searchParams.get("token")).toBe("test-token");
    expect(url.searchParams.get("value")).toBe("refinement-label");

    expect(requestOptions).toEqual({
      method: "POST",
    });
  });

  it("removes an existing label from a card", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 200,
      }),
    );

    const client = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });

    await client.removeLabel("card-1", "refinement-label");

    expect(fetchMock).toHaveBeenCalledOnce();

    const [requestUrl, requestOptions] = fetchMock.mock.calls[0] ?? [];
    const url = new URL(String(requestUrl));

    expect(url.pathname).toBe("/1/cards/card-1/idLabels/refinement-label");
    expect(url.searchParams.get("key")).toBe("test-key");
    expect(url.searchParams.get("token")).toBe("test-token");

    expect(requestOptions).toEqual({
      method: "DELETE",
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
