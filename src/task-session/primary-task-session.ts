import type {
  OpenCodeClient,
  OpenCodeRunOptions,
  OpenCodeRunResult,
} from "../opencode/opencode-client.js";
import { TaskExecutionStore } from "./task-execution-store.js";
import type { TaskExecutionRecord } from "./task-execution-record.js";

export class PrimaryTaskSessionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PrimaryTaskSessionError";
  }
}

function nextTimestamp(previousTimestamp: string): string {
  const previousMilliseconds = Date.parse(previousTimestamp);
  const now = Date.now();
  return new Date(Math.max(now, previousMilliseconds + 1)).toISOString();
}

function nextRevision(record: TaskExecutionRecord): number {
  return record.revision + 1;
}

function updateSessionCreationStatus(
  store: TaskExecutionStore,
  record: TaskExecutionRecord,
  status: "creating" | "ambiguous",
): TaskExecutionRecord {
  return store.compareAndSwap(record.cardId, record.revision, {
    ...record,
    sessionCreationStatus: status,
    revision: nextRevision(record),
    updatedAt: nextTimestamp(record.updatedAt),
  });
}

export async function runWithPrimaryTaskSession(
  store: TaskExecutionStore,
  openCode: OpenCodeClient,
  projectId: string,
  cardId: string,
  runOptions: Omit<OpenCodeRunOptions, "sessionId" | "captureSessionId">,
): Promise<OpenCodeRunResult> {
  const record = store.read(cardId);

  if (record === null) {
    throw new PrimaryTaskSessionError(
      `Cannot run OpenCode without a task execution record for ${projectId}/${cardId}`,
    );
  }

  if (record.projectId !== projectId || record.cardId !== cardId) {
    throw new PrimaryTaskSessionError(
      `Task execution record ownership does not match ${projectId}/${cardId}`,
    );
  }

  if (
    record.sessionCreationStatus === "creating" ||
    record.sessionCreationStatus === "ambiguous"
  ) {
    throw new PrimaryTaskSessionError(
      `Primary OpenCode session creation is ambiguous for ${projectId}/${cardId}; refusing to create a replacement`,
    );
  }

  if (record.primarySessionId !== undefined) {
    return openCode.run({ ...runOptions, sessionId: record.primarySessionId });
  }

  if (record.phase !== "planning") {
    throw new PrimaryTaskSessionError(
      `Cannot create a primary OpenCode session during the ${record.phase} phase`,
    );
  }

  const creatingRecord = updateSessionCreationStatus(store, record, "creating");
  let result: OpenCodeRunResult;

  try {
    result = await openCode.run({ ...runOptions, captureSessionId: true });

    if (result.sessionId === undefined) {
      throw new PrimaryTaskSessionError(
        "OpenCode did not return the created primary session ID",
      );
    }
  } catch (error) {
    try {
      updateSessionCreationStatus(store, creatingRecord, "ambiguous");
    } catch (stateError) {
      throw new PrimaryTaskSessionError(
        `Primary OpenCode session creation outcome is ambiguous for ${projectId}/${cardId}, and ambiguity could not be persisted`,
        { cause: new AggregateError([error, stateError]) },
      );
    }

    throw new PrimaryTaskSessionError(
      `Primary OpenCode session creation outcome is ambiguous for ${projectId}/${cardId}`,
      { cause: error },
    );
  }

  try {
    store.compareAndSwap(cardId, creatingRecord.revision, {
      ...creatingRecord,
      primarySessionId: result.sessionId,
      sessionCreationStatus: "bound",
      revision: nextRevision(creatingRecord),
      updatedAt: nextTimestamp(creatingRecord.updatedAt),
    });
    return result;
  } catch (error) {
    throw new PrimaryTaskSessionError(
      `Created primary OpenCode session could not be bound safely for ${projectId}/${cardId}; refusing to create a replacement`,
      { cause: error },
    );
  }
}
