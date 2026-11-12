import path from "node:path";
import { z } from "zod";

const stableId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, "Must be a nonempty stable ID");

const nonEmptyText = z.string().refine((value) => value.trim().length > 0, {
  message: "Must not be blank",
});

const contentIdentity = z.string().regex(/^(?:sha256:[0-9a-f]{64}|[0-9a-f]{40}|[0-9a-f]{64})$/u);

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
  id: stableId.optional(),
  sourceContentIdentity: contentIdentity.optional(),
  kind: z.enum(["defect", "incomplete", "contract-violation"]),
  summary: nonEmptyText,
  detail: nonEmptyText,
  location: reviewLocationSchema.optional(),
});

const previousFindingAssessmentSchema = z
  .strictObject({
    findingId: stableId,
    status: z.enum(["resolved", "unresolved", "superseded"]),
    justification: nonEmptyText.optional(),
  })
  .superRefine((assessment, ctx) => {
    if (assessment.status === "superseded" && assessment.justification === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["justification"],
        message: "Superseded findings require justification",
      });
    }
  });

export const implementationReviewResultSchema = z
  .strictObject({
    version: z.literal(1),
    projectId: stableId,
    cardId: stableId,
    verdict: z.enum(["pass", "fail"]),
    requirementAssessments: z.array(requirementAssessmentSchema),
    blockingFindings: z.array(blockingFindingSchema),
    previousFindingAssessments: z.array(previousFindingAssessmentSchema).optional(),
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

      if (assessment.status === "satisfied" && assessment.evidence.length === 0) {
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
        message: "A passing review cannot contain unsatisfied requirements or blocking findings",
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
        message: "A failed review requires an unsatisfied requirement or blocking finding",
      });
    }
  });

export type ImplementationReviewResult = z.infer<typeof implementationReviewResultSchema>;

const primaryFindingDispositionSchema = z.strictObject({
  findingId: stableId,
  status: z.enum(["addressed", "dismissed"]),
  rationale: nonEmptyText.max(4_000),
});

const primaryRequirementDispositionSchema = z.strictObject({
  requirementId: stableId,
  status: z.enum(["addressed", "dismissed"]),
  rationale: nonEmptyText.max(4_000),
});

const primaryFindingDispositionReportSchema = z.strictObject({
  version: z.literal(1),
  findingDispositions: z.array(primaryFindingDispositionSchema),
  requirementDispositions: z.array(primaryRequirementDispositionSchema),
});

export type PrimaryReviewDispositionReport = z.infer<typeof primaryFindingDispositionReportSchema>;

export interface PersistedReviewFindingDisposition {
  id: string;
  sourceIdentities: readonly string[];
  primaryDisposition?:
    | {
        reviewedContentIdentity: string;
        status: "addressed" | "dismissed";
        rationale: string;
      }
    | undefined;
}

export interface PersistedReviewRequirementDisposition {
  requirementId: string;
  reviewedContentIdentity: string;
  status: "addressed" | "dismissed";
  rationale: string;
}

export function hasUndisposedReviewConcerns(
  review: ImplementationReviewResult,
  findings: readonly PersistedReviewFindingDisposition[],
  requirementDispositions: readonly PersistedReviewRequirementDisposition[],
): boolean {
  const findingsById = new Map(findings.map((finding) => [finding.id, finding]));
  const requirementsById = new Map(
    requirementDispositions.map((disposition) => [disposition.requirementId, disposition]),
  );
  const unresolvedFinding = review.blockingFindings.some((finding) => {
    if (finding.id === undefined) return true;
    const persisted = findingsById.get(finding.id)?.primaryDisposition;
    return (
      persisted?.status !== "dismissed" ||
      persisted.reviewedContentIdentity !== review.reviewedContentIdentity
    );
  });
  const unresolvedRequirement = review.requirementAssessments.some((assessment) => {
    if (assessment.status !== "unsatisfied") return false;
    const persisted = requirementsById.get(assessment.requirementId);
    return (
      persisted?.status !== "dismissed" ||
      persisted.reviewedContentIdentity !== review.reviewedContentIdentity
    );
  });
  return unresolvedFinding || unresolvedRequirement;
}

export const reviewConcernsDismissedAsNonMaterialLabel =
  "Failed (primary assessed review concerns as non-material)";

export function parsePrimaryReviewDispositionReport(
  output: string,
  expectedFindingIds: readonly string[],
  expectedRequirementIds: readonly string[],
): PrimaryReviewDispositionReport | undefined {
  try {
    const parsed = primaryFindingDispositionReportSchema.parse(JSON.parse(output) as unknown);
    const receivedFindingIds = parsed.findingDispositions.map(({ findingId }) => findingId);
    const receivedRequirementIds = parsed.requirementDispositions.map(
      ({ requirementId }) => requirementId,
    );
    if (
      new Set(receivedFindingIds).size !== receivedFindingIds.length ||
      receivedFindingIds.length !== expectedFindingIds.length ||
      expectedFindingIds.some((id) => !receivedFindingIds.includes(id)) ||
      new Set(receivedRequirementIds).size !== receivedRequirementIds.length ||
      receivedRequirementIds.length !== expectedRequirementIds.length ||
      expectedRequirementIds.some((id) => !receivedRequirementIds.includes(id))
    )
      return undefined;
    return parsed;
  } catch {
    // A missing or malformed primary disposition is conservative: reviewers'
    // material findings remain unresolved for publication reporting.
    return undefined;
  }
}

export interface ImplementationReviewExpectations {
  projectId: string;
  cardId: string;
  requirementIds: readonly string[];
  contentIdentity: string;
  previousFindingIds?: readonly string[];
  previousFindings?: readonly {
    id: string;
    sourceContentIdentity?: string | undefined;
    sourceIdentities: readonly string[];
    status: "unresolved" | "resolved" | "superseded";
  }[];
}

export function parseImplementationReviewResult(
  value: unknown,
  expected: ImplementationReviewExpectations,
): ImplementationReviewResult {
  const result = implementationReviewResultSchema.parse(value);

  const expectedPreviousIds = expected.previousFindingIds ?? [];
  const assessments = result.previousFindingAssessments ?? [];
  const assessedPreviousIds = new Set(assessments.map(({ findingId }) => findingId));
  if (assessedPreviousIds.size !== assessments.length) {
    throw new Error("Implementation review duplicated a previous finding assessment");
  }
  const missingFindingId = expectedPreviousIds.find((id) => !assessedPreviousIds.has(id));
  if (missingFindingId !== undefined) {
    throw new Error(
      `Implementation review omitted previous finding assessment: ${missingFindingId}`,
    );
  }
  const unexpectedFindingId = [...assessedPreviousIds].find(
    (id) => !expectedPreviousIds.includes(id),
  );
  if (unexpectedFindingId !== undefined) {
    throw new Error(
      `Implementation review assessed unknown previous finding: ${unexpectedFindingId}`,
    );
  }
  if (expectedPreviousIds.length > 0 && result.previousFindingAssessments === undefined) {
    throw new Error("Implementation review omitted previous finding assessments");
  }

  const previousAssessments = new Map(
    assessments.map(({ findingId, status }) => [findingId, status]),
  );
  const previousFindings = new Map(
    (expected.previousFindings ?? []).map((finding) => [finding.id, finding]),
  );
  for (const finding of result.blockingFindings) {
    if (finding.id === undefined) continue;
    const status = previousAssessments.get(finding.id);
    if (status === undefined) {
      throw new Error(
        `Implementation review blocking finding references unknown prior finding: ${finding.id}`,
      );
    }
    if (status === "resolved") {
      const prior = previousFindings.get(finding.id);
      if (
        prior === undefined ||
        finding.sourceContentIdentity !== expected.contentIdentity ||
        prior.sourceIdentities.includes(expected.contentIdentity) ||
        finding.location === undefined ||
        finding.detail.trim().length === 0
      ) {
        throw new Error(
          `Implementation review reopened resolved prior finding without new supporting evidence: ${finding.id}`,
        );
      }
      continue;
    }
    if (status !== "unresolved") {
      throw new Error(
        `Implementation review lists ${status} prior finding as currently blocking: ${finding.id}`,
      );
    }
  }

  for (const assessment of assessments) {
    if (
      assessment.status === "unresolved" &&
      !result.blockingFindings.some((finding) => finding.id === assessment.findingId)
    ) {
      throw new Error(
        `Unresolved prior finding must remain in blockingFindings: ${assessment.findingId}`,
      );
    }
  }

  if (result.projectId !== expected.projectId || result.cardId !== expected.cardId) {
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
    (expectedIds.size === 0 && result.requirementAssessments.length > 0)
  ) {
    throw new Error("Implementation review assessments must match the available task requirements");
  }

  const assessedIds = new Set(
    result.requirementAssessments.map((assessment) => assessment.requirementId),
  );

  const missingId = expected.requirementIds.find((id) => !assessedIds.has(id));

  if (missingId !== undefined) {
    throw new Error(`Implementation review omitted requirement assessment: ${missingId}`);
  }

  const unexpectedId = [...assessedIds].find((id) => !expectedIds.has(id));

  if (unexpectedId !== undefined) {
    throw new Error(`Implementation review assessed unknown requirement: ${unexpectedId}`);
  }

  return result;
}

/** Validates an orchestrator-normalized cached review using its original prior-finding context. */
export function parseCachedImplementationReviewResult(
  value: unknown,
  expected: ImplementationReviewExpectations,
): ImplementationReviewResult {
  const cached = implementationReviewResultSchema.parse(value);
  if (expected.previousFindings !== undefined) {
    const previousIds = new Set(expected.previousFindingIds ?? []);
    const responseShape = {
      ...cached,
      // The ledger adds IDs to newly introduced findings after validation.
      // Retain IDs known in the original prior-finding set so unresolved
      // assessments remain linked to their blocking finding.
      blockingFindings: cached.blockingFindings.map((finding) =>
        finding.id !== undefined && !previousIds.has(finding.id)
          ? { ...finding, id: undefined }
          : finding,
      ),
    };
    parseImplementationReviewResult(responseShape, expected);
    return cached;
  }

  const legacyResponseShape = {
    ...cached,
    // Without the original prior-finding snapshot, cached IDs cannot reliably
    // distinguish prior findings from IDs assigned after validation.
    blockingFindings: cached.blockingFindings.map((finding) => ({
      ...finding,
      id: undefined,
    })),
  };

  // Older cached publications may not have retained the pre-review finding
  // snapshot. Validate task/content/requirement evidence without rerunning
  // response novelty rules against the already-updated finding ledger.
  parseImplementationReviewResult(
    { ...legacyResponseShape, previousFindingAssessments: [] },
    { ...expected, previousFindingIds: [], previousFindings: [] },
  );
  const assessments = cached.previousFindingAssessments ?? [];
  const assessmentIds = assessments.map(({ findingId }) => findingId);
  if (
    new Set(assessmentIds).size !== assessmentIds.length ||
    assessmentIds.length !== (expected.previousFindingIds ?? []).length ||
    (expected.previousFindingIds ?? []).some((id) => !assessmentIds.includes(id))
  )
    throw new Error("Cached implementation review prior assessments are incomplete");
  for (const assessment of assessments) {
    if (
      assessment.status === "unresolved" &&
      !cached.blockingFindings.some((finding) => finding.id === assessment.findingId)
    )
      throw new Error(
        `Cached unresolved prior finding is missing from blockingFindings: ${assessment.findingId}`,
      );
  }
  return cached;
}
