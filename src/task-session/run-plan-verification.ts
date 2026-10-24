import type { CardAttachmentPromptContext } from "../context/card-attachment-prompt.js";
import type {
  OpenCodeClient,
  OpenCodeRunOptions,
  OpenCodeRunResult,
} from "../opencode/opencode-client.js";
import type { TrelloCard } from "../trello/trello-client.js";
import { TaskExecutionStore } from "./task-execution-store.js";
import { TaskPlanStore } from "./task-plan-store.js";
import {
  buildPlanVerificationPrompt,
  parsePlanVerificationResult,
  type PlanVerificationResult,
} from "./plan-verification.js";

export class PlanVerificationOperationError extends Error {
  constructor(
    message: string,
    public readonly runResult?: OpenCodeRunResult,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PlanVerificationOperationError";
  }
}

export interface RunPlanVerificationOptions {
  taskRecordStore: TaskExecutionStore;
  planStore: TaskPlanStore;
  openCode: OpenCodeClient;
  projectId: string;
  card: TrelloCard;
  attachmentContext?: CardAttachmentPromptContext;
  runOptions: Omit<
    OpenCodeRunOptions,
    "prompt" | "sessionId" | "captureSessionId"
  >;
}

export interface PlanVerificationOperationResult {
  verification: PlanVerificationResult;
  runResult: OpenCodeRunResult;
}

export async function runPlanVerification(
  options: RunPlanVerificationOptions,
): Promise<PlanVerificationOperationResult> {
  const {
    taskRecordStore,
    planStore,
    openCode,
    projectId,
    card,
    attachmentContext,
    runOptions,
  } = options;
  const taskRecord = taskRecordStore.read(card.id);

  if (
    taskRecord === null ||
    taskRecord.projectId !== projectId ||
    taskRecord.cardId !== card.id ||
    taskRecord.phase !== "planning" ||
    taskRecord.primarySessionId === undefined ||
    taskRecord.sessionCreationStatus !== "bound"
  ) {
    throw new PlanVerificationOperationError(
      `Cannot verify a plan without the owned primary session in planning phase for ${projectId}/${card.id}`,
    );
  }

  const storedPlan = planStore.read(card.id, taskRecord.revision);

  if (storedPlan === null) {
    throw new PlanVerificationOperationError(
      `Cannot verify a missing task plan for ${projectId}/${card.id}`,
    );
  }

  const prompt = buildPlanVerificationPrompt({
    projectId,
    cardId: card.id,
    cardTitle: card.name,
    cardDescription: card.desc,
    planRevision: storedPlan.planRevision,
    plan: storedPlan.plan,
    ...(attachmentContext === undefined ? {} : { attachmentContext }),
  });

  const runResult = await openCode.run({ ...runOptions, prompt });

  if (runResult.exitCode !== 0) {
    throw new PlanVerificationOperationError(
      `Independent plan review exited with code ${runResult.exitCode}`,
      runResult,
    );
  }

  let verification: PlanVerificationResult;

  try {
    verification = parsePlanVerificationResult(
      JSON.parse(runResult.output) as unknown,
    );
  } catch (error) {
    throw new PlanVerificationOperationError(
      "Independent plan review returned a malformed structured result",
      runResult,
      { cause: error },
    );
  }

  if (
    verification.projectId !== projectId ||
    verification.cardId !== card.id ||
    verification.planRevision !== storedPlan.planRevision
  ) {
    throw new PlanVerificationOperationError(
      `Independent plan review identity does not match ${projectId}/${card.id} plan revision ${storedPlan.planRevision}`,
      runResult,
    );
  }

  const persistedVerification = planStore.storeVerification(
    card.id,
    storedPlan.planRevision,
    verification,
  );

  if (persistedVerification.verification === undefined) {
    throw new PlanVerificationOperationError(
      `Independent plan review was not persisted for ${projectId}/${card.id}`,
      runResult,
    );
  }

  return { verification: persistedVerification.verification, runResult };
}
