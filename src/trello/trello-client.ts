import { z } from "zod";

export interface TrelloClientOptions {
  apiKey: string;
  token: string;
  signal?: AbortSignal;
  timeoutMilliseconds?: number;
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

export interface TrelloLabel {
  id: string;
  name: string;
  color: string | null;
}

export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  idLabels: string[];
  url: string;
}

export interface TrelloCommentAction {
  id: string;
  type: string;
  date: string;
}

const trelloBoardSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
});

const trelloListSchema = z.object({
  id: z.string(),
  name: z.string(),
  closed: z.boolean(),
});

const trelloLabelSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
});

const trelloCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  desc: z.string(),
  idList: z.string(),
  idLabels: z.array(z.string()),
  url: z.string(),
});

const trelloCommentActionSchema = z.object({
  id: z.string(),
  type: z.string(),
  date: z.string(),
});

export class TrelloRequestAbortedError extends Error {
  constructor() {
    super("Trello request aborted");
    this.name = "TrelloRequestAbortedError";
  }
}

export class TrelloClient {
  private readonly baseUrl = "https://api.trello.com/1";

  constructor(private readonly options: TrelloClientOptions) {}

  private getRequestSignal(): AbortSignal | undefined {
    const { signal, timeoutMilliseconds } = this.options;

    if (signal !== undefined && timeoutMilliseconds !== undefined) {
      return AbortSignal.any([
        signal,
        AbortSignal.timeout(timeoutMilliseconds),
      ]);
    }

    if (signal !== undefined) {
      return signal;
    }

    if (timeoutMilliseconds !== undefined) {
      return AbortSignal.timeout(timeoutMilliseconds);
    }

    return undefined;
  }

  private throwIfAborted(): void {
    if (this.options.signal?.aborted) {
      throw new TrelloRequestAbortedError();
    }
  }

  private async request(url: URL, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (this.options.signal?.aborted) {
        throw new TrelloRequestAbortedError();
      }

      throw error;
    }
  }

  getBoard(boardId: string): Promise<TrelloBoard> {
    return this.get(`/boards/${boardId}`, trelloBoardSchema);
  }

  getLists(boardId: string): Promise<TrelloList[]> {
    return this.get(`/boards/${boardId}/lists`, z.array(trelloListSchema));
  }

  getLabels(boardId: string): Promise<TrelloLabel[]> {
    return this.get(`/boards/${boardId}/labels`, z.array(trelloLabelSchema));
  }

  getCards(listId: string): Promise<TrelloCard[]> {
    return this.get(`/lists/${listId}/cards`, z.array(trelloCardSchema));
  }

  moveCard(
    cardId: string,
    listId: string,
    options: {
      dueComplete?: boolean;
    } = {},
  ): Promise<TrelloCard> {
    const parameters: Record<string, string> = {
      idList: listId,
      pos: "top",
    };

    if (options.dueComplete !== undefined) {
      parameters.dueComplete = String(options.dueComplete);
    }

    return this.put(`/cards/${cardId}`, parameters, trelloCardSchema);
  }

  updateCardContent(
    cardId: string,
    title: string,
    description: string,
  ): Promise<TrelloCard> {
    return this.put(
      `/cards/${cardId}`,
      {
        name: title,
        desc: description,
      },
      trelloCardSchema,
    );
  }

  async addLabel(cardId: string, labelId: string): Promise<void> {
    await this.postWithoutResponse(`/cards/${cardId}/idLabels`, {
      value: labelId,
    });
  }

  async removeLabel(cardId: string, labelId: string): Promise<void> {
    await this.delete(`/cards/${cardId}/idLabels/${labelId}`);
  }

  addComment(cardId: string, text: string): Promise<TrelloCommentAction> {
    return this.post(
      `/cards/${cardId}/actions/comments`,
      { text },
      trelloCommentActionSchema,
    );
  }

  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    this.throwIfAborted();

    const url = new URL(`${this.baseUrl}${path}`);

    url.searchParams.set("key", this.options.apiKey);
    url.searchParams.set("token", this.options.token);

    const signal = this.getRequestSignal();
    const response = await this.request(url, signal ? { signal } : undefined);

    if (!response.ok) {
      throw new Error(
        `Trello request failed: ${response.status} ${response.statusText}`,
      );
    }

    return schema.parse(await response.json());
  }

  private async put<T>(
    path: string,
    parameters: Record<string, string>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    this.throwIfAborted();

    const url = new URL(`${this.baseUrl}${path}`);

    url.searchParams.set("key", this.options.apiKey);
    url.searchParams.set("token", this.options.token);

    for (const [name, value] of Object.entries(parameters)) {
      url.searchParams.set(name, value);
    }

    const signal = this.getRequestSignal();
    const response = await this.request(url, {
      method: "PUT",
      ...(signal === undefined ? {} : { signal }),
    });

    if (!response.ok) {
      throw new Error(
        `Trello request failed: ${response.status} ${response.statusText}`,
      );
    }

    return schema.parse(await response.json());
  }

  private async postWithoutResponse(
    path: string,
    parameters: Record<string, string>,
  ): Promise<void> {
    this.throwIfAborted();

    const url = new URL(`${this.baseUrl}${path}`);

    url.searchParams.set("key", this.options.apiKey);
    url.searchParams.set("token", this.options.token);

    for (const [name, value] of Object.entries(parameters)) {
      url.searchParams.set(name, value);
    }

    const signal = this.getRequestSignal();
    const response = await this.request(url, {
      method: "POST",
      ...(signal === undefined ? {} : { signal }),
    });

    if (!response.ok) {
      throw new Error(
        `Trello request failed: ${response.status} ${response.statusText}`,
      );
    }
  }

  private async post<T>(
    path: string,
    parameters: Record<string, string>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    this.throwIfAborted();

    const url = new URL(`${this.baseUrl}${path}`);

    url.searchParams.set("key", this.options.apiKey);
    url.searchParams.set("token", this.options.token);

    for (const [name, value] of Object.entries(parameters)) {
      url.searchParams.set(name, value);
    }

    const signal = this.getRequestSignal();
    const response = await this.request(url, {
      method: "POST",
      ...(signal === undefined ? {} : { signal }),
    });

    if (!response.ok) {
      throw new Error(
        `Trello request failed: ${response.status} ${response.statusText}`,
      );
    }

    return schema.parse(await response.json());
  }

  private async delete(path: string): Promise<void> {
    this.throwIfAborted();

    const url = new URL(`${this.baseUrl}${path}`);

    url.searchParams.set("key", this.options.apiKey);
    url.searchParams.set("token", this.options.token);

    const signal = this.getRequestSignal();
    const response = await this.request(url, {
      method: "DELETE",
      ...(signal === undefined ? {} : { signal }),
    });

    if (!response.ok) {
      throw new Error(
        `Trello request failed: ${response.status} ${response.statusText}`,
      );
    }
  }
}
