import { z } from "zod";

import {
  parseTaskExecutionRecord,
  taskExecutionEventTypes,
  type TaskExecutionPhase,
  type TaskExecutionRecord,
} from "./task-execution-record.js";

const eventIdentitySchema = z.strictObject({
  eventId: z
    .string()
    .min(1)
    .refine((value) => value.trim() === value, "Event ID must not be padded"),
  projectId: z
    .string()
    .min(1)
    .refine((value) => value.trim() === value),
  cardId: z
    .string()
    .min(1)
    .refine((value) => value.trim() === value),
  operationKey: z
    .string()
    .min(1)
    .refine((value) => value.trim() === value),
  occurredAt: z.string().datetime(),
});

const taskExecutionEventSchema = z.discriminatedUnion("type", [
  eventIdentitySchema.extend({ type: z.literal("plan-approved") }),
  eventIdentitySchema.extend({ type: z.literal("implementation-completed") }),
  eventIdentitySchema.extend({ type: z.literal("validation-passed") }),
  eventIdentitySchema.extend({ type: z.literal("validation-exhausted") }),
  eventIdentitySchema.extend({ type: z.literal("validation-failed") }),
  eventIdentitySchema.extend({ type: z.literal("review-passed") }),
  eventIdentitySchema.extend({ type: z.literal("review-exhausted") }),
  eventIdentitySchema.extend({ type: z.literal("review-unavailable") }),
  eventIdentitySchema.extend({ type: z.literal("review-failed") }),
  eventIdentitySchema.extend({
    type: z.literal("publication-completed"),
    pullRequest: z.strictObject({
      number: z.number().int().positive(),
      url: z.url(),
      headSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i),
    }),
  }),
  eventIdentitySchema.extend({
    type: z.literal("ci-passed-awaiting-human"),
  }),
  eventIdentitySchema.extend({ type: z.literal("ci-passed-completed") }),
  eventIdentitySchema.extend({ type: z.literal("pull-request-merged") }),
  eventIdentitySchema.extend({ type: z.literal("ci-failed") }),
  eventIdentitySchema.extend({ type: z.literal("feedback-received") }),
  eventIdentitySchema.extend({ type: z.literal("feedback-ci-failed") }),
  eventIdentitySchema.extend({
    type: z.literal("feedback-replies-published"),
  }),
  eventIdentitySchema.extend({ type: z.literal("attention-required") }),
]);

export type TaskExecutionEvent = z.infer<typeof taskExecutionEventSchema>;

export class TaskExecutionTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskExecutionTransitionError";
  }
}

const phaseTransitions: Record<
  TaskExecutionEvent["type"],
  {
    from: TaskExecutionPhase | readonly TaskExecutionPhase[] | null;
    to: TaskExecutionPhase;
  }
> = {
  "plan-approved": { from: "planning", to: "implementation" },
  "implementation-completed": { from: "implementation", to: "validation" },
  "validation-passed": { from: "validation", to: "review" },
  "validation-exhausted": { from: "validation", to: "publication" },
  "validation-failed": { from: "validation", to: "implementation" },
  "review-passed": { from: "review", to: "publication" },
  "review-exhausted": { from: "review", to: "publication" },
  "review-unavailable": { from: "review", to: "publication" },
  "review-failed": { from: "review", to: "implementation" },
  "publication-completed": { from: "publication", to: "ci" },
  "ci-passed-awaiting-human": { from: "ci", to: "human-feedback" },
  "ci-passed-completed": { from: "ci", to: "done" },
  "pull-request-merged": { from: ["ci", "human-feedback"], to: "done" },
  "ci-failed": { from: "ci", to: "implementation" },
  "feedback-received": { from: "human-feedback", to: "implementation" },
  "feedback-ci-failed": { from: "human-feedback", to: "ci" },
  "feedback-replies-published": { from: "human-feedback", to: "ci" },
  "attention-required": { from: null, to: "attention-required" },
};

function isTerminalPhase(phase: TaskExecutionPhase): boolean {
  return phase === "done" || phase === "attention-required";
}

export function transitionTaskExecutionRecord(
  recordInput: TaskExecutionRecord,
  eventInput: TaskExecutionEvent,
): TaskExecutionRecord {
  const record = parseTaskExecutionRecord(recordInput);
  const event = taskExecutionEventSchema.parse(eventInput);

  if (event.projectId !== record.projectId || event.cardId !== record.cardId) {
    throw new TaskExecutionTransitionError(
      "Task execution event ownership does not match the record",
    );
  }

  if (event.operationKey !== record.operationKey) {
    throw new TaskExecutionTransitionError(
      "Task execution event operation identity does not match the record",
    );
  }

  if (record.lastEvent?.id === event.eventId) {
    const eventPullRequest =
      event.type === "publication-completed" ? event.pullRequest : undefined;

    if (
      record.lastEvent.type === event.type &&
      record.lastEvent.operationKey === event.operationKey &&
      record.lastEvent.occurredAt === event.occurredAt &&
      JSON.stringify(record.lastEvent.pullRequest) ===
        JSON.stringify(eventPullRequest)
    ) {
      return record;
    }

    throw new TaskExecutionTransitionError(
      `Task execution event ID was reused with different content: ${event.eventId}`,
    );
  }

  if (isTerminalPhase(record.phase)) {
    throw new TaskExecutionTransitionError(
      `Cannot transition from terminal phase ${record.phase}`,
    );
  }

  const transition = phaseTransitions[event.type];
  const destinationPhase = transition.to;

  const allowedSourcePhases = Array.isArray(transition.from)
    ? transition.from
    : transition.from === null
      ? null
      : [transition.from];
  if (
    allowedSourcePhases !== null &&
    !allowedSourcePhases.includes(record.phase)
  ) {
    throw new TaskExecutionTransitionError(
      `Event ${event.type} is not allowed during the ${record.phase} phase`,
    );
  }

  if (Date.parse(event.occurredAt) < Date.parse(record.updatedAt)) {
    throw new TaskExecutionTransitionError(
      "Task execution event timestamp is earlier than the record update timestamp",
    );
  }

  const nextRecord = parseTaskExecutionRecord({
    ...record,
    phase: destinationPhase,
    lastEvent: {
      id: event.eventId,
      type: event.type,
      operationKey: event.operationKey,
      occurredAt: event.occurredAt,
      ...(event.type === "publication-completed"
        ? { pullRequest: event.pullRequest }
        : {}),
    },
    ...(event.type === "publication-completed"
      ? { pullRequest: event.pullRequest }
      : {}),
    revision: record.revision + 1,
    updatedAt: event.occurredAt,
  });

  return nextRecord;
}

export const TASK_EXECUTION_EVENT_TYPES = taskExecutionEventTypes;
