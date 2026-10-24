import type { CardAttachmentPromptContext } from "../context/card-attachment-prompt.js";
import {
  OpenCodeClient,
  extractOpenCodeTextOutput,
  type OpenCodeRunOptions,
  type OpenCodeRunResult,
} from "../opencode/opencode-client.js";
import { buildTaskPlanningPrompt } from "../opencode/build-task-planning-prompt.js";
import type { TrelloAttachment, TrelloCard } from "../trello/trello-client.js";
import { runWithPrimaryTaskSession } from "./primary-task-session.js";
import { TaskExecutionStore } from "./task-execution-store.js";
import { TaskPlanStore, type StoredTaskPlan } from "./task-plan-store.js";
import { parseTaskPlan, type TaskPlan } from "./task-plan.js";

export class TaskPlanningOperationError extends Error {
  constructor(
    message: string,
    public readonly runResult?: OpenCodeRunResult,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TaskPlanningOperationError";
  }
}

export interface RunTaskPlanningOptions {
  taskRecordStore: TaskExecutionStore;
  planStore: TaskPlanStore;
  openCode: OpenCodeClient;
  projectId: string;
  card: TrelloCard;
  attachments?: readonly TrelloAttachment[];
  attachmentContext?: CardAttachmentPromptContext;
  runOptions: Omit<
    OpenCodeRunOptions,
    "prompt" | "sessionId" | "captureSessionId"
  >;
}

export interface TaskPlanningOperationResult {
  plan: TaskPlan;
  storedPlan: StoredTaskPlan;
  runResult: OpenCodeRunResult;
}

function parsePlanArtifact(output: string): TaskPlan {
  const assistantText = extractOpenCodeTextOutput(output);
  let value: unknown;

  try {
    value = JSON.parse(assistantText) as unknown;
  } catch (error) {
    throw new TaskPlanningOperationError(
      "OpenCode planning response was not a JSON plan artifact",
      undefined,
      { cause: error },
    );
  }

  return parseTaskPlan(value);
}

export async function runTaskPlanningOperation(
  options: RunTaskPlanningOptions,
): Promise<TaskPlanningOperationResult> {
  const {
    taskRecordStore,
    planStore,
    openCode,
    projectId,
    card,
    attachments = [],
    attachmentContext,
    runOptions,
  } = options;

  if (planStore.read(card.id) !== null) {
    throw new TaskPlanningOperationError(
      `A plan already exists for ${projectId}/${card.id}; refusing to replace it`,
    );
  }

  const prompt = buildTaskPlanningPrompt(
    projectId,
    card,
    attachments,
    attachmentContext,
  );
  const runResult = await runWithPrimaryTaskSession(
    taskRecordStore,
    openCode,
    projectId,
    card.id,
    { ...runOptions, prompt },
  );

  if (runResult.exitCode !== 0) {
    throw new TaskPlanningOperationError(
      `OpenCode planning exited with code ${runResult.exitCode}`,
      runResult,
    );
  }

  let plan: TaskPlan;

  try {
    plan = parsePlanArtifact(runResult.output);
  } catch (error) {
    throw new TaskPlanningOperationError(
      "Could not parse and validate the OpenCode task plan",
      runResult,
      { cause: error },
    );
  }

  if (plan.projectId !== projectId || plan.cardId !== card.id) {
    throw new TaskPlanningOperationError(
      `OpenCode task plan identity does not match ${projectId}/${card.id}`,
      runResult,
    );
  }

  const taskRecord = taskRecordStore.read(card.id);

  if (
    taskRecord === null ||
    taskRecord.projectId !== projectId ||
    taskRecord.cardId !== card.id ||
    taskRecord.phase !== "planning" ||
    taskRecord.primarySessionId === undefined ||
    taskRecord.sessionCreationStatus !== "bound"
  ) {
    throw new TaskPlanningOperationError(
      `Task ownership or planning phase changed before the plan could be saved for ${projectId}/${card.id}`,
      runResult,
    );
  }

  const storedPlan = planStore.create(plan, taskRecord.revision);

  return { plan, storedPlan, runResult };
}
