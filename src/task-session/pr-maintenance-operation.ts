import { z } from "zod";

const id = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.trim() === value &&
      value !== "." &&
      value !== ".." &&
      !value.includes("/") &&
      !value.includes("\\") &&
      !Array.from(value).some((character) => {
        const code = character.codePointAt(0);
        return (
          code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f))
        );
      }),
    "Must be a safe non-blank identifier",
  );
const gitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i);
const maintenanceQualityEvidenceSchema = z.strictObject({
  status: z.enum(["running", "failed", "uncertain", "passed"]),
  preparedHead: gitSha,
  contentIdentity: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  validation: z.unknown().optional(),
  coverage: z.unknown().nullable().optional(),
  review: z.unknown().optional(),
  diagnostic: z.string().optional(),
});
export const localPreparationSchema = z.strictObject({
  status: z.enum([
    "fetching-base",
    "base-fetched",
    "backing-up",
    "rebasing",
    "conflicted",
    "prepared",
  ]),
  originalHead: gitSha,
  baseHead: gitSha.optional(),
  backupRef: z.string().min(1).optional(),
  resultingHead: gitSha.optional(),
  conflictedPaths: z.array(z.string().min(1)).optional(),
  updatedAt: z.string().datetime(),
});

export const prMaintenanceOperationSchema = z
  .strictObject({
    version: z.literal(1),
    projectId: id,
    cardId: id,
    pullRequest: z.strictObject({
      number: z.number().int().positive(),
      url: z.url(),
    }),
    expectedRemoteHead: gitSha,
    targetBaseHead: gitSha,
    operationId: id,
    status: z.enum(["prepared", "active", "uncertain", "completed"]),
    ownerToken: z.uuid().optional(),
    ownerPid: z.number().int().positive().optional(),
    localPreparation: localPreparationSchema.optional(),
    qualityVerification: maintenanceQualityEvidenceSchema.optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((operation, ctx) => {
    if (
      (operation.ownerToken === undefined) !==
      (operation.ownerPid === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["ownerToken"],
        message: "Owner token and PID must be stored together",
      });
    }
    if (operation.status !== "active" && operation.ownerToken !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["ownerToken"],
        message: "Only active operations may have a live owner",
      });
    }
    if (Date.parse(operation.updatedAt) < Date.parse(operation.createdAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "Must not be earlier than createdAt",
      });
    }
  });

export type PrMaintenanceOperation = z.infer<
  typeof prMaintenanceOperationSchema
>;
export type LocalPreparationProgress = z.infer<typeof localPreparationSchema>;
export type MaintenanceQualityEvidence = z.infer<
  typeof maintenanceQualityEvidenceSchema
>;

export function parsePrMaintenanceOperation(
  value: unknown,
): PrMaintenanceOperation {
  return prMaintenanceOperationSchema.parse(value);
}
