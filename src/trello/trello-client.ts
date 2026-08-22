export interface TrelloClientOptions {
  apiKey: string;
  token: string;
}

export interface TrelloBoard {
  id: string;
  name: string;
  url: string;
}

export interface TrelloList {
  id: string;
  name: string;
  closed: boolean;
}

export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  url: string;
}

export interface TrelloCommentAction {
  id: string;
  type: string;
  date: string;
}

export class TrelloClient {
  private readonly baseUrl = "https://api.trello.com/1";

  constructor(private readonly options: TrelloClientOptions) {}

  getBoard(boardId: string): Promise<TrelloBoard> {
    return this.get<TrelloBoard>(`/boards/${boardId}`);
  }

  getLists(boardId: string): Promise<TrelloList[]> {
    return this.get<TrelloList[]>(`/boards/${boardId}/lists`);
  }

  getCards(listId: string): Promise<TrelloCard[]> {
    return this.get<TrelloCard[]>(`/lists/${listId}/cards`);
  }

  moveCard(cardId: string, listId: string): Promise<TrelloCard> {
    return this.put<TrelloCard>(`/cards/${cardId}`, {
      idList: listId,
      pos: "top",
    });
  }

  addComment(cardId: string, text: string): Promise<TrelloCommentAction> {
    return this.post<TrelloCommentAction>(`/cards/${cardId}/actions/comments`, {
      text,
    });
  }

  private async get<T>(path: string): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);

    url.searchParams.set("key", this.options.apiKey);
    url.searchParams.set("token", this.options.token);

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Trello request failed: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as T;
  }

  private async put<T>(
    path: string,
    parameters: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);

    url.searchParams.set("key", this.options.apiKey);
    url.searchParams.set("token", this.options.token);

    for (const [name, value] of Object.entries(parameters)) {
      url.searchParams.set(name, value);
    }

    const response = await fetch(url, {
      method: "PUT",
    });

    if (!response.ok) {
      throw new Error(
        `Trello request failed: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as T;
  }

  private async post<T>(
    path: string,
    parameters: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);

    url.searchParams.set("key", this.options.apiKey);
    url.searchParams.set("token", this.options.token);

    for (const [name, value] of Object.entries(parameters)) {
      url.searchParams.set(name, value);
    }

    const response = await fetch(url, {
      method: "POST",
    });

    if (!response.ok) {
      throw new Error(
        `Trello request failed: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as T;
  }
}
