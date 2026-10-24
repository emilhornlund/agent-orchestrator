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

export const taskExecutionEventTypes = [
  "plan-approved",
  "implementation-completed",
  "validation-passed",
  "validation-failed",
  "review-passed",
  "review-failed",
  "publication-completed",
  "ci-passed-awaiting-human",
  "ci-passed-completed",
  "ci-failed",
  "feedback-received",
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

const sessionCreationStatus = z.enum(["creating", "bound", "ambiguous"]);

const retryCountersSchema = z.strictObject({
  validation: z.number().int().nonnegative(),
  review: z.number().int().nonnegative(),
  ci: z.number().int().nonnegative(),
  humanFeedback: z.number().int().nonnegative(),
});

const taskSessionContentIdentity = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

const validationEvidenceSchema = z.strictObject({
  command: nonBlankIdentifier,
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  exitCode: z.literal(0),
  diagnostic: z.string().max(2_000),
  contentIdentity: taskSessionContentIdentity,
});

const validationRepairSchema = z.strictObject({
  cycleId: nonBlankIdentifier,
  status: z.enum(["active", "passed", "exhausted"]),
  evidence: validationEvidenceSchema.optional(),
  coverageEvidence: validationEvidenceSchema.optional(),
});

const reviewRepairSchema = z.strictObject({
  cycleId: nonBlankIdentifier,
  status: z.enum(["active", "passed", "exhausted"]),
});

const ciRepairSchema = z.strictObject({
  cycleId: nonBlankIdentifier,
  headSha: gitSha,
  status: z.enum(["active", "passed", "exhausted"]),
});

const taskExecutionRecordSchema = z
  .strictObject({
    version: z.literal(1),
    projectId: ownerId,
    cardId: ownerId,
    phase: z.enum(taskExecutionPhases),
    primarySessionId: nonBlankIdentifier.optional(),
    sessionCreationStatus: sessionCreationStatus.optional(),
    expectedBranch: nonBlankIdentifier.optional(),
    pullRequest: pullRequestSchema.optional(),
    operationKey: nonBlankIdentifier,
    lastEvent: z
      .strictObject({
        id: nonBlankIdentifier,
        type: z.enum(taskExecutionEventTypes),
        operationKey: nonBlankIdentifier,
        occurredAt: z.string().datetime(),
        pullRequest: pullRequestSchema.optional(),
      })
      .optional(),
    validationRepair: validationRepairSchema.optional(),
    reviewRepair: reviewRepairSchema.optional(),
    ciRepair: ciRepairSchema.optional(),
    revision: z.number().int().positive().safe(),
    retryCounters: retryCountersSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((record, ctx) => {
    if (
      record.sessionCreationStatus === "bound" &&
      record.primarySessionId === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["primarySessionId"],
        message: "Required when session creation is bound",
      });
    }

    if (
      (record.sessionCreationStatus === "creating" ||
        record.sessionCreationStatus === "ambiguous") &&
      record.primarySessionId !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["sessionCreationStatus"],
        message:
          "Cannot have a primary session ID before session creation is bound",
      });
    }

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

    if (record.validationRepair !== undefined) {
      if (
        record.validationRepair.status !== "passed" &&
        record.phase !== "validation"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["validationRepair"],
          message:
            "Unresolved validation repair state is only valid during validation",
        });
      }

      if (record.retryCounters.validation > 2) {
        ctx.addIssue({
          code: "custom",
          path: ["retryCounters", "validation"],
          message: "Validation repair attempts cannot exceed two per cycle",
        });
      }

      if (
        record.validationRepair.status === "exhausted" &&
        record.retryCounters.validation !== 2
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["validationRepair", "status"],
          message: "Exhausted validation repair requires two attempts",
        });
      }

      if (
        record.validationRepair.status === "passed" &&
        record.validationRepair.evidence === undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["validationRepair", "evidence"],
          message: "Passing validation requires content-bound evidence",
        });
      }

      if (
        record.validationRepair.status !== "passed" &&
        record.validationRepair.evidence !== undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["validationRepair", "evidence"],
          message: "Only passing validation may store successful evidence",
        });
      }

      if (
        record.validationRepair.status !== "passed" &&
        record.validationRepair.coverageEvidence !== undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["validationRepair", "coverageEvidence"],
          message: "Only passing coverage may store successful evidence",
        });
      }

      if (
        record.validationRepair.evidence !== undefined &&
        record.validationRepair.coverageEvidence !== undefined &&
        record.validationRepair.evidence.contentIdentity !==
          record.validationRepair.coverageEvidence.contentIdentity
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["validationRepair", "coverageEvidence", "contentIdentity"],
          message:
            "Validation and coverage evidence must share a source snapshot",
        });
      }
    }

    if (record.reviewRepair !== undefined) {
      const activeReviewRepairPhases = [
        "implementation",
        "validation",
        "review",
        "attention-required",
      ];

      if (
        record.reviewRepair.status === "active" &&
        !activeReviewRepairPhases.includes(record.phase)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["reviewRepair", "status"],
          message: `Active review repair is not valid during the ${record.phase} phase`,
        });
      }

      if (
        record.reviewRepair.status !== "active" &&
        record.phase !== "review"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["reviewRepair", "status"],
          message:
            "Completed review repair is only valid during the review phase",
        });
      }

      if (record.retryCounters.review > 2) {
        ctx.addIssue({
          code: "custom",
          path: ["retryCounters", "review"],
          message: "Review repair attempts cannot exceed two per cycle",
        });
      }

      if (
        record.reviewRepair.status === "exhausted" &&
        record.retryCounters.review !== 2
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["reviewRepair", "status"],
          message: "Exhausted review repair requires two attempts",
        });
      }
    }

    if (record.ciRepair !== undefined) {
      if (
        record.ciRepair.status !== "active" &&
        record.phase !== "ci" &&
        !(
          record.ciRepair.status === "exhausted" &&
          record.phase === "attention-required"
        )
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["ciRepair", "status"],
          message:
            "Completed CI repair state must remain in CI or attention-required",
        });
      }
      if (record.retryCounters.ci > 2) {
        ctx.addIssue({
          code: "custom",
          path: ["retryCounters", "ci"],
          message: "CI repair attempts cannot exceed two per failure cycle",
        });
      }
      if (
        record.ciRepair.status === "exhausted" &&
        record.retryCounters.ci !== 2
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["ciRepair", "status"],
          message: "Exhausted CI repair requires two attempts",
        });
      }
    }
  });

export type TaskExecutionPhase = (typeof taskExecutionPhases)[number];
export type TaskExecutionRecord = z.infer<typeof taskExecutionRecordSchema>;

export function parseTaskExecutionRecord(value: unknown): TaskExecutionRecord {
  return taskExecutionRecordSchema.parse(value);
}
