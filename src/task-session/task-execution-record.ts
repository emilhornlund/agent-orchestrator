import { z } from "zod";
import { implementationReviewResultSchema } from "./implementation-review-result.js";

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
  "validation-exhausted",
  "validation-failed",
  "review-passed",
  "review-exhausted",
  "review-unavailable",
  "review-failed",
  "publication-completed",
  "ci-passed-awaiting-human",
  "ci-passed-completed",
  "pull-request-merged",
  "external-pull-request-reconciled",
  "ci-failed",
  "feedback-received",
  "feedback-ci-failed",
  "feedback-replies-published",
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

const taskSetupState = z.strictObject({
  command: z.string().min(1).nullable(),
  status: z.enum(["not-required", "pending", "active", "passed"]),
});

const terminalFailureState = z.strictObject({
  kind: z.literal("implementation"),
  reason: z.string().min(1).max(4_000),
  outcome: z.enum(["confirmed", "pending"]),
});

const externalRecoveryState = z.strictObject({
  implementationCommit: gitSha,
  recoveryBranch: nonBlankIdentifier,
  pullRequestNumber: z.number().int().positive(),
  pullRequestUrl: z.url(),
  status: z.enum(["verified", "move-pending", "card-moved"]),
  requestedAt: z.string().datetime(),
});

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
  maxAttempts: z.number().int().nonnegative().safe().optional(),
  finalReview: implementationReviewResultSchema.optional(),
  findings: z
    .array(
      z.strictObject({
        id: nonBlankIdentifier,
        kind: z.enum(["defect", "incomplete", "contract-violation"]),
        summary: z.string().min(1),
        detail: z.string().min(1),
        location: z
          .strictObject({
            filePath: z.string().min(1),
            line: z.number().int().positive().optional(),
          })
          .optional(),
        sourceContentIdentity: taskSessionContentIdentity,
        sourceIdentities: z.array(taskSessionContentIdentity).min(1),
        status: z.enum(["unresolved", "resolved", "superseded"]),
        justification: z.string().min(1).optional(),
      }),
    )
    .superRefine((findings, ctx) => {
      const ids = new Set<string>();
      for (const [index, finding] of findings.entries()) {
        if (ids.has(finding.id)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "id"],
            message: `Duplicate tracked finding identifier: ${finding.id}`,
          });
        }
        ids.add(finding.id);
        if (
          finding.status === "superseded" &&
          finding.justification === undefined
        ) {
          ctx.addIssue({
            code: "custom",
            path: [index, "justification"],
            message: "Superseded tracked findings require justification",
          });
        }
      }
    })
    .optional(),
});

const ciRepairSchema = z.strictObject({
  cycleId: nonBlankIdentifier,
  headSha: gitSha,
  status: z.enum(["active", "passed", "exhausted"]),
});

const feedbackRemediationSchema = z.strictObject({
  operationId: nonBlankIdentifier,
  status: z.enum(["active", "changed", "no-op", "failed"]),
  headSha: gitSha,
  ledgerRevision: z.number().int().positive().safe(),
});

const reviewObservationSchema = z.strictObject({
  headSha: gitSha,
  observedAt: z.string().datetime(),
  ciEvaluation: z.strictObject({
    status: z.enum(["waiting", "passed", "failed", "uncertain"]),
    expectedCheckNames: z.array(nonBlankIdentifier),
    missingChecks: z.array(nonBlankIdentifier),
    pendingChecks: z.array(nonBlankIdentifier),
    failureCheckNames: z.array(nonBlankIdentifier),
    diagnostic: z.string().optional(),
  }),
  feedbackIds: z.array(nonBlankIdentifier),
});

const publicationQualitySchema = z.strictObject({
  contentIdentity: taskSessionContentIdentity,
  validation: validationEvidenceSchema,
  coverageEvidence: validationEvidenceSchema.optional(),
  review: z.unknown(),
});

const taskExecutionRecordSchema = z
  .strictObject({
    version: z.literal(1),
    projectId: ownerId,
    cardId: ownerId,
    phase: z.enum(taskExecutionPhases),
    primarySessionId: nonBlankIdentifier.optional(),
    sessionCreationStatus: sessionCreationStatus.optional(),
    setup: taskSetupState.optional(),
    terminalFailure: terminalFailureState.optional(),
    externalRecovery: externalRecoveryState.optional(),
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
    reviewRemediationFailure: z
      .strictObject({
        cycleId: nonBlankIdentifier,
        attempt: z.number().int().positive().safe(),
        before: taskSessionContentIdentity,
        after: taskSessionContentIdentity.nullable(),
        unchanged: z.boolean(),
        diagnostic: z.string().min(1).max(500),
      })
      .optional(),
    reviewUnavailable: z
      .strictObject({
        contentIdentity: taskSessionContentIdentity,
        diagnostic: z.string().min(1).max(500),
      })
      .optional(),
    ciRepair: ciRepairSchema.optional(),
    feedbackRemediation: feedbackRemediationSchema.optional(),
    /** Consumed before an operator-authorized failed feedback checkpoint is resumed. */
    feedbackRecoveryAttemptEventId: nonBlankIdentifier.optional(),
    reviewObservation: reviewObservationSchema.optional(),
    publicationQuality: publicationQualitySchema.optional(),
    humanReviewNotificationCommitShas: z.array(gitSha).optional(),
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
        record.validationRepair.status === "active" &&
        record.phase !== "validation"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["validationRepair"],
          message:
            "Active validation repair state is only valid during validation",
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
        record.phase !== "review" &&
        !(
          ["passed", "exhausted"].includes(record.reviewRepair.status) &&
          [
            "publication",
            "ci",
            "human-feedback",
            "attention-required",
            "done",
          ].includes(record.phase)
        )
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["reviewRepair", "status"],
          message:
            "Completed review repair is only valid during the review phase",
        });
      }

      const { maxAttempts, finalReview } = record.reviewRepair;
      if (
        maxAttempts !== undefined &&
        record.retryCounters.review > maxAttempts
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["retryCounters", "review"],
          message: "Review repair attempts exceeded the configured maximum",
        });
      }
      if (
        record.reviewRepair.status === "exhausted" &&
        maxAttempts !== undefined &&
        record.retryCounters.review !== maxAttempts
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["reviewRepair", "status"],
          message:
            "Exhausted review repair requires the configured number of attempts",
        });
      }
      if (
        finalReview !== undefined &&
        (finalReview.projectId !== record.projectId ||
          finalReview.cardId !== record.cardId ||
          (record.reviewRepair.status === "passed") !==
            (finalReview.verdict === "pass"))
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["reviewRepair", "finalReview"],
          message: "Final review must match task ownership and repair outcome",
        });
      }
    }

    if (record.ciRepair !== undefined) {
      if (
        record.ciRepair.status !== "active" &&
        !["ci", "human-feedback", "done"].includes(record.phase) &&
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

    if (
      record.feedbackRemediation?.status === "active" &&
      record.phase !== "human-feedback"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["feedbackRemediation"],
        message:
          "Feedback remediation state is only valid during human feedback",
      });
    }

    if (
      record.reviewObservation !== undefined &&
      record.pullRequest?.headSha !== record.reviewObservation.headSha
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["reviewObservation", "headSha"],
        message:
          "Review observation head must match the persisted pull request head",
      });
    }

    if (
      record.reviewObservation !== undefined &&
      record.phase !== "human-feedback" &&
      record.phase !== "ci" &&
      record.phase !== "attention-required"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["reviewObservation"],
        message: "Review observations are only valid for Human Review tasks",
      });
    }
  });

export type TaskExecutionPhase = (typeof taskExecutionPhases)[number];
export type TaskExecutionRecord = z.infer<typeof taskExecutionRecordSchema>;

export function parseTaskExecutionRecord(value: unknown): TaskExecutionRecord {
  return taskExecutionRecordSchema.parse(value);
}
