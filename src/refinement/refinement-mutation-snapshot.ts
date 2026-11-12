import { z } from "zod";

export const refinementFieldsSchema = z.strictObject({
  title: z.string(),
  description: z.string(),
  labels: z.array(z.string()),
});
export const refinementHistoryActionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["updateCard", "addLabelToCard", "removeLabelFromCard"]),
  idMemberCreator: z.string().min(1),
  data: z.object({
    old: z.object({ name: z.string().optional(), desc: z.string().optional() }).optional(),
    card: z.object({
      id: z.string(),
      name: z.string().optional(),
      desc: z.string().optional(),
    }),
    label: z.object({ id: z.string() }).optional(),
  }),
});
export type RefinementHistoryAction = z.infer<typeof refinementHistoryActionSchema>;

export const refinementMutationSnapshotSchema = z.strictObject({
  cardId: z.string().min(1),
  original: z.strictObject({
    title: z.string(),
    description: z.string(),
    labels: z.array(z.string()),
  }),
  intended: z.strictObject({
    title: z.string().min(1),
    description: z.string().min(1),
    type: z.enum(["feature", "improvement", "bug"]),
    labels: z.array(z.string()),
  }),
  reconciliation: z
    .strictObject({
      actorId: z.string().min(1),
      cursor: z.string().nullable(),
      verified: refinementFieldsSchema,
      pending: refinementFieldsSchema.optional(),
      conflict: z.string().optional(),
      evidence: z.unknown().optional(),
      mode: z.enum(["applying", "restoring", "restored"]).optional(),
      abandonedMutationIds: z.array(z.string()).optional(),
    })
    .optional(),
});
export const refinementMutationSnapshotKey = "refinement-mutation-foundation-v1";
