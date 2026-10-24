import { z } from "zod";

const dispositionSchema = z.discriminatedUnion("status", [
  z.strictObject({
    feedbackId: z.string().min(1),
    status: z.literal("verified-fixed"),
    evidence: z.array(z.string().min(1)).min(1),
  }),
  z.strictObject({
    feedbackId: z.string().min(1),
    status: z.literal("unresolved"),
    reason: z.string().min(1),
  }),
]);

const feedbackVerificationSchema = z.strictObject({
  version: z.literal(1),
  projectId: z.string().min(1),
  cardId: z.string().min(1),
  headSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu),
  contentIdentity: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  dispositions: z.array(dispositionSchema),
});

export type FeedbackDisposition = z.infer<typeof dispositionSchema>;
export type FeedbackVerificationResult = z.infer<
  typeof feedbackVerificationSchema
>;

export interface FeedbackVerificationExpectations {
  projectId: string;
  cardId: string;
  headSha: string;
  contentIdentity: string;
  actionableFeedbackIds: readonly string[];
}

export function parseFeedbackVerificationResult(
  value: unknown,
  expected: FeedbackVerificationExpectations,
): FeedbackVerificationResult {
  const result = feedbackVerificationSchema.parse(value);
  if (
    result.projectId !== expected.projectId ||
    result.cardId !== expected.cardId ||
    result.headSha !== expected.headSha ||
    result.contentIdentity !== expected.contentIdentity
  ) {
    throw new Error(
      "Feedback verification identity or source snapshot does not match the current task",
    );
  }
  const expectedIds = new Set(expected.actionableFeedbackIds);
  const dispositionIds = new Set(
    result.dispositions.map((item) => item.feedbackId),
  );
  if (
    expectedIds.size !== expected.actionableFeedbackIds.length ||
    expectedIds.size === 0
  ) {
    throw new Error(
      "Expected actionable feedback IDs must be unique and nonempty",
    );
  }
  if (dispositionIds.size !== result.dispositions.length) {
    throw new Error("Feedback verification contains duplicate dispositions");
  }
  for (const id of expectedIds) {
    if (!dispositionIds.has(id))
      throw new Error(`Feedback verification omitted item: ${id}`);
  }
  for (const id of dispositionIds) {
    if (!expectedIds.has(id))
      throw new Error(`Feedback verification invented item: ${id}`);
  }
  return result;
}
