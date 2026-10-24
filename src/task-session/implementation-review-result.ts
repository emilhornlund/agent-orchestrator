import path from "node:path";
import { z } from "zod";

const stableId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, "Must be a nonempty stable ID");

const nonEmptyText = z.string().refine((value) => value.trim().length > 0, {
  message: "Must not be blank",
});

const contentIdentity = z
  .string()
  .regex(/^(?:sha256:[0-9a-f]{64}|[0-9a-f]{40}|[0-9a-f]{64})$/u);

const requirementAssessmentSchema = z.strictObject({
  requirementId: stableId,
  status: z.enum(["satisfied", "unsatisfied"]),
  details: nonEmptyText,
  evidence: z.array(nonEmptyText),
});

const reviewLocationSchema = z.strictObject({
  filePath: nonEmptyText.refine(
    (filePath) =>
      !path.isAbsolute(filePath) &&
      !path.win32.isAbsolute(filePath) &&
      filePath.split(/[\\/]/u).every((component) => component !== ".."),
    "Review location must be a repository-relative path without traversal",
  ),
  line: z.number().int().positive().optional(),
});

const blockingFindingSchema = z.strictObject({
  kind: z.enum(["defect", "incomplete", "contract-violation"]),
  summary: nonEmptyText,
  detail: nonEmptyText,
  location: reviewLocationSchema.optional(),
});

const implementationReviewResultSchema = z
  .strictObject({
    version: z.literal(1),
    projectId: stableId,
    cardId: stableId,
    verdict: z.enum(["pass", "fail"]),
    requirementAssessments: z.array(requirementAssessmentSchema).min(1),
    blockingFindings: z.array(blockingFindingSchema),
    reviewedContentIdentity: contentIdentity,
  })
  .superRefine((result, ctx) => {
    const assessmentIds = new Set<string>();
    let hasUnsatisfiedRequirement = false;

    for (const [index, assessment] of result.requirementAssessments.entries()) {
      if (assessmentIds.has(assessment.requirementId)) {
        ctx.addIssue({
          code: "custom",
          path: ["requirementAssessments", index, "requirementId"],
          message: `Duplicate requirement assessment: ${assessment.requirementId}`,
        });
      }

      assessmentIds.add(assessment.requirementId);

      if (
        assessment.status === "satisfied" &&
        assessment.evidence.length === 0
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["requirementAssessments", index, "evidence"],
          message: "Satisfied requirements require concrete evidence",
        });
      }

      if (assessment.status === "unsatisfied") {
        hasUnsatisfiedRequirement = true;
      }
    }

    if (
      result.verdict === "pass" &&
      (hasUnsatisfiedRequirement || result.blockingFindings.length > 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["verdict"],
        message:
          "A passing review cannot contain unsatisfied requirements or blocking findings",
      });
    }

    if (
      result.verdict === "fail" &&
      !hasUnsatisfiedRequirement &&
      result.blockingFindings.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["blockingFindings"],
        message:
          "A failed review requires an unsatisfied requirement or blocking finding",
      });
    }
  });

export type ImplementationReviewResult = z.infer<
  typeof implementationReviewResultSchema
>;

export interface ImplementationReviewExpectations {
  projectId: string;
  cardId: string;
  requirementIds: readonly string[];
  contentIdentity: string;
}

export function parseImplementationReviewResult(
  value: unknown,
  expected: ImplementationReviewExpectations,
): ImplementationReviewResult {
  const result = implementationReviewResultSchema.parse(value);

  if (
    result.projectId !== expected.projectId ||
    result.cardId !== expected.cardId
  ) {
    throw new Error("Implementation review task identity does not match");
  }

  if (result.reviewedContentIdentity !== expected.contentIdentity) {
    throw new Error(
      `Implementation review content identity is stale: expected ${expected.contentIdentity}, received ${result.reviewedContentIdentity}`,
    );
  }

  const expectedIds = new Set(expected.requirementIds);

  if (
    expectedIds.size !== expected.requirementIds.length ||
    expectedIds.size === 0
  ) {
    throw new Error(
      "Expected implementation review requirements must be unique and nonempty",
    );
  }

  const assessedIds = new Set(
    result.requirementAssessments.map((assessment) => assessment.requirementId),
  );

  const missingId = expected.requirementIds.find((id) => !assessedIds.has(id));

  if (missingId !== undefined) {
    throw new Error(
      `Implementation review omitted requirement assessment: ${missingId}`,
    );
  }

  const unexpectedId = [...assessedIds].find((id) => !expectedIds.has(id));

  if (unexpectedId !== undefined) {
    throw new Error(
      `Implementation review assessed unknown requirement: ${unexpectedId}`,
    );
  }

  return result;
}
