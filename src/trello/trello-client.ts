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

export interface TrelloAttachment {
  id: string;
  name: string;
  mimeType: string | null;
  bytes: string | null;
  url: string;
  isUpload: boolean;
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

export type TrelloRequestOperation =
  | "board lookup"
  | "list lookup"
  | "label lookup"
  | "card lookup"
  | "card action lookup"
  | "transition history"
  | "card move"
  | "card content update"
  | "label update"
  | "comment"
  | "attachment metadata"
  | "attachment download";

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

const trelloAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string().nullable(),
  bytes: z.string().nullable(),
  url: z.string(),
  isUpload: z.boolean(),
});

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

export class TrelloRequestError extends Error {
  readonly operation: TrelloRequestOperation;
  readonly status: number | undefined;
  readonly statusCode: number | undefined;
  readonly retryable: boolean;
  readonly classification: "retryable" | "non-retryable";

  constructor(
    operation: TrelloRequestOperation,
    message: string,
    options: ErrorOptions & {
      status?: number;
      retryable?: boolean;
    } = {},
  ) {
    super(message, options);
    this.name = "TrelloRequestError";
    this.operation = operation;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.statusCode = this.status;
    this.classification = this.retryable ? "retryable" : "non-retryable";
  }
}

export class TrelloRequestTimeoutError extends TrelloRequestError {
  constructor(operation: TrelloRequestOperation, cause?: unknown) {
    super(
      operation,
      `Trello request timed out during ${operation}`,
      cause === undefined ? {} : { cause, retryable: true },
    );
    this.name = "TrelloRequestTimeoutError";
  }
}

const transientHttpStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);

function errorChain(error: unknown): Error[] {
  const errors: Error[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    errors.push(current);
    current = current.cause;
  }

  return errors;
}

function isTimeoutReason(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    "name" in reason &&
    reason.name === "TimeoutError"
  );
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return message
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, "[redacted URL]")
    .replace(
      /([?&](?:key|token|api[_-]?key|access[_-]?token|password|secret)=)[^&#\s]+/gi,
      "$1[redacted]",
    );
}

function throwForResponse(
  operation: TrelloRequestOperation,
  response: Response,
): never {
  throw new TrelloRequestError(
    operation,
    `Trello request failed: ${response.status} ${response.statusText}`,
    {
      status: response.status,
      retryable: transientHttpStatuses.has(response.status),
    },
  );
}

function hasTransientStatus(error: unknown): boolean {
  const statuses: unknown[] = [];

  for (const entry of errorChain(error)) {
    const candidate = entry as Error & {
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown };
    };

    statuses.push(
      candidate.status,
      candidate.statusCode,
      candidate.response?.status,
    );
  }

  return statuses.some(
    (status) => typeof status === "number" && transientHttpStatuses.has(status),
  );
}

/** Returns true only for failures that can reasonably succeed later. */
export function isRetryableTrelloError(error: unknown): boolean {
  if (
    errorChain(error).some(
      (entry) => entry instanceof TrelloRequestAbortedError,
    )
  ) {
    return false;
  }

  const errors = errorChain(error);

  if (
    errors.some((entry) =>
      /github|opencode|commandrunner|smtp/i.test(entry.name),
    )
  ) {
    return false;
  }

  if (errors.some((entry) => entry instanceof TrelloRequestError)) {
    return errors.some(
      (entry) => entry instanceof TrelloRequestError && entry.retryable,
    );
  }

  const messages = errors.map((entry) => entry.message.toLowerCase());
  const message = messages.join("\n");

  if (!message.includes("trello")) {
    return false;
  }

  if (/\b(?:http\s*)?(?:401|403|404)\b/.test(message)) {
    return false;
  }

  if (hasTransientStatus(error)) {
    return true;
  }

  return messages.some(
    (entry) =>
      entry.includes("timed out") ||
      entry.includes("timeout") ||
      entry.includes("etimedout") ||
      entry.includes("econnreset") ||
      entry.includes("econnrefused") ||
      entry.includes("enetunreach") ||
      entry.includes("ehostunreach") ||
      entry.includes("eai_again") ||
      entry.includes("socket hang up") ||
      entry.includes("temporary network") ||
      entry.includes("temporary connectivity") ||
      entry.includes("temporary failure in name resolution") ||
      entry.includes("network error") ||
      entry.includes("network is unreachable") ||
      entry.includes("connection reset") ||
      entry.includes("connection refused") ||
      entry.includes("connection aborted") ||
      entry.includes("failed to fetch") ||
      entry.includes("service unavailable") ||
      /\b(?:http\s*)?(?:408|425|429|500|502|503|504)\b/.test(entry),
  );
}

export function getTrelloRequestOperation(
  error: unknown,
): TrelloRequestOperation | undefined {
  return errorChain(error).find(
    (entry): entry is TrelloRequestError => entry instanceof TrelloRequestError,
  )?.operation;
}

export class TrelloClient {
  private readonly baseUrl = "https://api.trello.com/1";

  constructor(private readonly options: TrelloClientOptions) {}

  private getRequestSignal(): AbortSignal | undefined {
    return this.getRequestSignalFor();
  }

  private getRequestSignalFor(
    additionalSignal?: AbortSignal,
  ): AbortSignal | undefined {
    const { signal, timeoutMilliseconds } = this.options;
    const signals = [signal, additionalSignal].filter(
      (candidate): candidate is AbortSignal => candidate !== undefined,
    );

    if (timeoutMilliseconds !== undefined) {
      signals.push(AbortSignal.timeout(timeoutMilliseconds));
    }

    if (signals.length > 1) {
      return AbortSignal.any(signals);
    }

    return signals[0];
  }

  private throwIfAborted(additionalSignal?: AbortSignal): void {
    if (this.options.signal?.aborted || additionalSignal?.aborted) {
      throw new TrelloRequestAbortedError();
    }
  }

  private async request(
    url: URL,
    operation: TrelloRequestOperation,
    init?: RequestInit,
  ): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (
        this.options.signal?.aborted ||
        (init?.signal?.aborted && !isTimeoutReason(init.signal.reason))
      ) {
        throw new TrelloRequestAbortedError();
      }

      if (init?.signal?.aborted && isTimeoutReason(init.signal.reason)) {
        throw new TrelloRequestTimeoutError(operation, error);
      }

      throw new TrelloRequestError(
        operation,
        `Trello request failed during ${operation}: ${safeErrorMessage(error)}`,
        { cause: error, retryable: true },
      );
    }
  }

  getBoard(boardId: string): Promise<TrelloBoard> {
    return this.get(
      `/boards/${boardId}`,
      trelloBoardSchema,
      {},
      "board lookup",
    );
  }

  getLists(boardId: string): Promise<TrelloList[]> {
    return this.get(
      `/boards/${boardId}/lists`,
      z.array(trelloListSchema),
      {},
      "list lookup",
    );
  }

  getLabels(boardId: string): Promise<TrelloLabel[]> {
    return this.get(
      `/boards/${boardId}/labels`,
      z.array(trelloLabelSchema),
      {},
      "label lookup",
    );
  }

  getCards(listId: string): Promise<TrelloCard[]> {
    return this.get(
      `/lists/${listId}/cards`,
      z.array(trelloCardSchema),
      {},
      "card lookup",
    );
  }

  getCardAttachments(
    cardId: string,
    signal?: AbortSignal,
  ): Promise<TrelloAttachment[]> {
    return this.get(
      `/cards/${cardId}/attachments`,
      z.array(trelloAttachmentSchema),
      {},
      "attachment metadata",
      signal,
    );
  }

  async downloadCardAttachment(
    attachment: TrelloAttachment,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (!attachment.isUpload) {
      throw new Error(
        `Refusing to download non-upload Trello attachment "${attachment.id}"`,
      );
    }

    let url: URL;

    try {
      url = new URL(attachment.url);
    } catch (error) {
      throw new Error(
        `Invalid Trello attachment URL for "${attachment.id}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }

    if (
      url.protocol !== "https:" ||
      (url.port !== "" && url.port !== "443") ||
      !["trello.com", "www.trello.com", "api.trello.com"].includes(url.hostname)
    ) {
      throw new Error(
        `Refusing to send Trello credentials to non-Trello attachment URL for "${attachment.id}"`,
      );
    }

    const pathSegments = url.pathname.split("/");

    if (
      pathSegments.length < 7 ||
      pathSegments[1] !== "1" ||
      pathSegments[2] !== "cards" ||
      pathSegments[3]?.length === 0 ||
      pathSegments[4] !== "attachments" ||
      pathSegments[5]?.length === 0 ||
      pathSegments[6] !== "download"
    ) {
      throw new Error(
        `Refusing non-attachment Trello URL for uploaded attachment "${attachment.id}"`,
      );
    }

    this.throwIfAborted(signal);

    url.searchParams.set("key", this.options.apiKey);
    url.searchParams.set("token", this.options.token);

    const requestSignal = this.getRequestSignalFor(signal);
    const response = await this.request(
      url,
      "attachment download",
      requestSignal === undefined ? undefined : { signal: requestSignal },
    );

    if (!response.ok) {
      throw new TrelloRequestError(
        "attachment download",
        `Trello request failed: ${response.status} ${response.statusText}`,
        {
          status: response.status,
          retryable: transientHttpStatuses.has(response.status),
        },
      );
    }

    return response;
  }

  async getListTransitions(
    cardId: string,
  ): Promise<TrelloListTransition[] | null> {
    const actions = await this.getCardActions(cardId, "transition history");
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

  getCardActions(
    cardId: string,
    operation: TrelloRequestOperation = "card action lookup",
  ): Promise<TrelloCardAction[]> {
    return this.get(
      `/cards/${cardId}/actions`,
      z.array(trelloCardActionSchema),
      { filter: "updateCard", limit: "1000" },
      operation,
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

    return this.put(
      `/cards/${cardId}`,
      parameters,
      trelloCardSchema,
      "card move",
    );
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
      "card content update",
    );
  }

  async addLabel(cardId: string, labelId: string): Promise<void> {
    await this.postWithoutResponse(
      `/cards/${cardId}/idLabels`,
      {
        value: labelId,
      },
      "label update",
    );
  }

  async removeLabel(cardId: string, labelId: string): Promise<void> {
    await this.delete(`/cards/${cardId}/idLabels/${labelId}`, "label update");
  }

  addComment(cardId: string, text: string): Promise<TrelloCommentAction> {
    return this.post(
      `/cards/${cardId}/actions/comments`,
      { text },
      trelloCommentActionSchema,
      "comment",
    );
  }

  private async get<T>(
    path: string,
    schema: z.ZodType<T>,
    parameters: Record<string, string> = {},
    operation: TrelloRequestOperation = "card lookup",
    additionalSignal?: AbortSignal,
  ): Promise<T> {
    this.throwIfAborted(additionalSignal);

    const url = new URL(`${this.baseUrl}${path}`);

    url.searchParams.set("key", this.options.apiKey);
    url.searchParams.set("token", this.options.token);

    for (const [name, value] of Object.entries(parameters)) {
      url.searchParams.set(name, value);
    }

    const signal = this.getRequestSignalFor(additionalSignal);
    const response = await this.request(
      url,
      operation,
      signal ? { signal } : undefined,
    );

    if (!response.ok) {
      throwForResponse(operation, response);
    }

    return schema.parse(await response.json());
  }

  private async put<T>(
    path: string,
    parameters: Record<string, string>,
    schema: z.ZodType<T>,
    operation: TrelloRequestOperation,
  ): Promise<T> {
    this.throwIfAborted();

    const url = new URL(`${this.baseUrl}${path}`);

    url.searchParams.set("key", this.options.apiKey);
    url.searchParams.set("token", this.options.token);

    for (const [name, value] of Object.entries(parameters)) {
      url.searchParams.set(name, value);
    }

    const signal = this.getRequestSignal();
    const response = await this.request(url, operation, {
      method: "PUT",
      ...(signal === undefined ? {} : { signal }),
    });

    if (!response.ok) {
      throwForResponse(operation, response);
    }

    return schema.parse(await response.json());
  }

  private async postWithoutResponse(
    path: string,
    parameters: Record<string, string>,
    operation: TrelloRequestOperation,
  ): Promise<void> {
    this.throwIfAborted();

    const url = new URL(`${this.baseUrl}${path}`);

    url.searchParams.set("key", this.options.apiKey);
    url.searchParams.set("token", this.options.token);

    for (const [name, value] of Object.entries(parameters)) {
      url.searchParams.set(name, value);
    }

    const signal = this.getRequestSignal();
    const response = await this.request(url, operation, {
      method: "POST",
      ...(signal === undefined ? {} : { signal }),
    });

    if (!response.ok) {
      throwForResponse(operation, response);
    }
  }

  private async post<T>(
    path: string,
    parameters: Record<string, string>,
    schema: z.ZodType<T>,
    operation: TrelloRequestOperation,
  ): Promise<T> {
    this.throwIfAborted();

    const url = new URL(`${this.baseUrl}${path}`);

    url.searchParams.set("key", this.options.apiKey);
    url.searchParams.set("token", this.options.token);

    for (const [name, value] of Object.entries(parameters)) {
      url.searchParams.set(name, value);
    }

    const signal = this.getRequestSignal();
    const response = await this.request(url, operation, {
      method: "POST",
      ...(signal === undefined ? {} : { signal }),
    });

    if (!response.ok) {
      throwForResponse(operation, response);
    }

    return schema.parse(await response.json());
  }

  private async delete(
    path: string,
    operation: TrelloRequestOperation,
  ): Promise<void> {
    this.throwIfAborted();

    const url = new URL(`${this.baseUrl}${path}`);

    url.searchParams.set("key", this.options.apiKey);
    url.searchParams.set("token", this.options.token);

    const signal = this.getRequestSignal();
    const response = await this.request(url, operation, {
      method: "DELETE",
      ...(signal === undefined ? {} : { signal }),
    });

    if (!response.ok) {
      throwForResponse(operation, response);
    }
  }
}
