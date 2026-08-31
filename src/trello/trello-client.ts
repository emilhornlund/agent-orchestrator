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

export interface TrelloCardAction {
  id: string;
  type: string;
  date: string;
  data?:
    | {
        listBefore?: { id: string } | undefined;
        listAfter?: { id: string } | undefined;
      }
    | undefined;
}

export interface TrelloListTransition {
  id: string;
  date: string;
  listBeforeId: string;
  listAfterId: string;
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

const trelloCardResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  desc: z.string(),
  idList: z.string(),
  idLabels: z.array(z.string()),
  url: z.string(),
});

const trelloCardSchema = trelloCardResponseSchema;

const trelloCardActionSchema = z.object({
  id: z.string(),
  type: z.string(),
  date: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "Must be a valid date",
  }),
  data: z
    .object({
      listBefore: z.object({ id: z.string() }).optional(),
      listAfter: z.object({ id: z.string() }).optional(),
    })
    .optional(),
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

  async getListTransitions(
    cardId: string,
  ): Promise<TrelloListTransition[] | null> {
    const actions = await this.getCardActions(cardId);
    let hasIncompleteListTransition = false;
    const transitions = actions.flatMap((action) => {
      const listBefore = action.data?.listBefore;
      const listAfter = action.data?.listAfter;

      if (listBefore === undefined || listAfter === undefined) {
        if (listBefore !== undefined || listAfter !== undefined) {
          hasIncompleteListTransition = true;
        }

        return [];
      }

      return [
        {
          id: action.id,
          date: action.date,
          listBeforeId: listBefore.id,
          listAfterId: listAfter.id,
        },
      ];
    });

    if (hasIncompleteListTransition) {
      return null;
    }

    return transitions;
  }

  async getLatestListTransition(
    cardId: string,
    destinationListId: string,
  ): Promise<TrelloListTransition | null> {
    const transitions = await this.getListTransitions(cardId);

    return (
      [...(transitions ?? [])]
        .sort((left, right) => Date.parse(right.date) - Date.parse(left.date))
        .find((transition) => transition.listAfterId === destinationListId) ??
      null
    );
  }

  getCardActions(cardId: string): Promise<TrelloCardAction[]> {
    return this.get(
      `/cards/${cardId}/actions`,
      z.array(trelloCardActionSchema),
      { filter: "updateCard", limit: "1000" },
    );
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

  private async get<T>(
    path: string,
    schema: z.ZodType<T>,
    parameters: Record<string, string> = {},
  ): Promise<T> {
    this.throwIfAborted();

    const url = new URL(`${this.baseUrl}${path}`);

    url.searchParams.set("key", this.options.apiKey);
    url.searchParams.set("token", this.options.token);

    for (const [name, value] of Object.entries(parameters)) {
      url.searchParams.set(name, value);
    }

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
