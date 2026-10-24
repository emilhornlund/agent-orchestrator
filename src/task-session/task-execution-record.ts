import { z } from "zod";

const taskExecutionPhases = [
  "planning",
  "implementation",
  "validation",
  "review",
  "publication",
  "ci",
  "human-feedback",
  "done",
  "attention-required",
] as const;

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0);

    return (
      code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f))
    );
  });
}

const ownerId = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.trim() === value &&
      value !== "." &&
      value !== ".." &&
      !value.includes("/") &&
      !value.includes("\\") &&
      !hasControlCharacter(value),
    "Must be a non-padded ID without path separators or control characters",
  );

const nonBlankIdentifier = z
  .string()
  .min(1)
  .refine(
    (value) => value.trim() === value && !hasControlCharacter(value),
    "Must be a non-padded identifier without control characters",
  );

const gitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i);

const pullRequestSchema = z.strictObject({
  number: z.number().int().positive(),
  url: z.url(),
  headSha: gitSha.optional(),
});

const retryCountersSchema = z.strictObject({
  validation: z.number().int().nonnegative(),
  review: z.number().int().nonnegative(),
  ci: z.number().int().nonnegative(),
  humanFeedback: z.number().int().nonnegative(),
});

const taskExecutionRecordSchema = z
  .strictObject({
    version: z.literal(1),
    projectId: ownerId,
    cardId: ownerId,
    phase: z.enum(taskExecutionPhases),
    primarySessionId: nonBlankIdentifier.optional(),
    expectedBranch: nonBlankIdentifier.optional(),
    pullRequest: pullRequestSchema.optional(),
    operationKey: nonBlankIdentifier,
    revision: z.number().int().positive().safe(),
    retryCounters: retryCountersSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((record, ctx) => {
    const executionHasStarted = [
      "implementation",
      "validation",
      "review",
      "publication",
      "ci",
      "human-feedback",
      "done",
    ].includes(record.phase);

    if (executionHasStarted && record.primarySessionId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["primarySessionId"],
        message: `Required during the ${record.phase} phase`,
      });
    }

    const repositoryWorkHasStarted = [
      "implementation",
      "validation",
      "review",
      "publication",
      "ci",
      "human-feedback",
      "done",
    ].includes(record.phase);

    if (repositoryWorkHasStarted && record.expectedBranch === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["expectedBranch"],
        message: `Required during the ${record.phase} phase`,
      });
    }

    const pullRequestIsRequired = ["ci", "human-feedback", "done"].includes(
      record.phase,
    );

    if (pullRequestIsRequired && record.pullRequest === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["pullRequest"],
        message: `Required during the ${record.phase} phase`,
      });
    }

    if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "Must not be earlier than createdAt",
      });
    }
  });

export type TaskExecutionPhase = (typeof taskExecutionPhases)[number];
export type TaskExecutionRecord = z.infer<typeof taskExecutionRecordSchema>;

export function parseTaskExecutionRecord(value: unknown): TaskExecutionRecord {
  return taskExecutionRecordSchema.parse(value);
}
