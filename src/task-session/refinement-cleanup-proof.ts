import { z } from "zod";
import type { RunRecord } from "./run-record.js";

export const refinementCleanupProofKey = "refinement-cleanup-proof-v1";
export const refinementCleanupProofSchema = z.strictObject({
  kind: z.literal("refinement-processes-stopped"),
  attemptId: z.string().min(1),
  cardId: z.string().min(1),
  headSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
});

/** A refinement has no PR fence. Its verified terminal outcome is independent. */
export function isCompletedRefinement(run: RunRecord): boolean {
  return (
    run.taskKind === "refinement" &&
    run.lifecycle === "refined" &&
    run.publicationState === "none" &&
    run.terminalSync === "verified" &&
    run.terminalEvidence?.prOutcome === "refinement-completed" &&
    run.terminalEvidence.trelloListId === run.pinned.lists.backlog
  );
}

export function readRefinementCleanupProof(
  run: RunRecord,
  readArtifact: (reference: string) => Buffer,
): z.infer<typeof refinementCleanupProofSchema> | null {
  if (!isCompletedRefinement(run)) return null;
  const value = run.compatibility[refinementCleanupProofKey];
  if (value === undefined) return null;
  const reference = z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/u)
    .parse(value);
  if (!run.artifacts.some((artifact) => artifact.id === reference))
    throw new Error("Refinement cleanup proof is not referenced by its attempt");
  const proof = refinementCleanupProofSchema.parse(
    JSON.parse(readArtifact(reference).toString("utf8")),
  );
  if (proof.cardId !== run.cardId || proof.attemptId !== run.attemptId)
    throw new Error("Refinement cleanup proof belongs to another attempt");
  return proof;
}
