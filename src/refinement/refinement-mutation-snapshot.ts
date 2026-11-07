import { z } from "zod";

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
});
export const refinementMutationSnapshotKey =
  "refinement-mutation-foundation-v1";
