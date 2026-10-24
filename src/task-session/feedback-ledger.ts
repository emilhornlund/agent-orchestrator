import { z } from "zod";

const sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu);
const feedbackEntrySchema = z.strictObject({
  kind: z.enum(["review", "inline-comment", "conversation-comment"]),
  id: z
    .string()
    .min(1)
    .refine((value) => value.trim() === value),
  author: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().nullable(),
  body: z.string(),
  commitSha: sha.optional(),
  headSha: sha.optional(),
  path: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  threadId: z.string().min(1).optional(),
  isResolved: z.boolean().optional(),
  isOutdated: z.boolean().optional(),
  actionability: z.enum([
    "unclassified",
    "actionable",
    "discussion",
    "not-actionable",
  ]),
  status: z.enum(["pending", "verified", "escalated", "published"]),
  verificationEvidence: z.array(z.string().min(1)),
  remediationCommitSha: sha.optional(),
  replyId: z.string().min(1).optional(),
});

const feedbackLedgerSchema = z
  .strictObject({
    version: z.literal(1),
    projectId: z.string().min(1),
    cardId: z.string().min(1),
    revision: z.number().int().positive().safe(),
    updatedAt: z.string().datetime(),
    entries: z.array(feedbackEntrySchema),
  })
  .superRefine((ledger, ctx) => {
    const keys = new Set<string>();
    for (const [index, entry] of ledger.entries.entries()) {
      const key = `${entry.kind}:${entry.id}`;
      if (keys.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "id"],
          message: `Duplicate feedback identity: ${key}`,
        });
      }
      keys.add(key);
      if (
        entry.status === "verified" &&
        entry.verificationEvidence.length === 0
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "verificationEvidence"],
          message: "Verified feedback requires evidence",
        });
      }
      if (entry.status === "published" && entry.replyId === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "replyId"],
          message: "Published feedback requires a reply ID",
        });
      }
    }
  });

export type FeedbackLedgerEntry = z.infer<typeof feedbackEntrySchema>;
export type FeedbackLedger = z.infer<typeof feedbackLedgerSchema>;

export function parseFeedbackLedger(value: unknown): FeedbackLedger {
  return feedbackLedgerSchema.parse(value);
}
