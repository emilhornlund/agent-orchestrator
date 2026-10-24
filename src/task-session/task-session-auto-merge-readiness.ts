import type { RequiredCheckObservation } from "../github/github-client.js";
import {
  decideVerifiedPublication,
  type VerifiedPublicationDecisionInput,
} from "./verified-publication-decision.js";

export interface TaskSessionAutoMergeReadinessInput {
  expectedHeadSha: string;
  observedHeadSha: string;
  requiredCheckNames: readonly string[];
  checks: readonly RequiredCheckObservation[];
  localEvidence: VerifiedPublicationDecisionInput;
}

export interface TaskSessionAutoMergeReadiness {
  allowed: boolean;
  reasons: string[];
  headSha: string;
}

export function decideTaskSessionAutoMergeReadiness(
  input: TaskSessionAutoMergeReadinessInput,
): TaskSessionAutoMergeReadiness {
  const reasons: string[] = [];
  if (
    input.expectedHeadSha !== input.observedHeadSha ||
    input.expectedHeadSha.trim().length === 0
  ) {
    reasons.push("Observed PR head does not match the expected head");
  }
  if (
    input.requiredCheckNames.length === 0 ||
    new Set(input.requiredCheckNames).size !== input.requiredCheckNames.length
  ) {
    reasons.push("Required check configuration is missing or duplicated");
  }
  const byName = new Map(input.checks.map((check) => [check.name, check]));
  if (byName.size !== input.checks.length) {
    reasons.push("Observed required checks contain duplicate names");
  }
  for (const name of input.requiredCheckNames) {
    const check = byName.get(name);
    if (check === undefined) {
      reasons.push(`Required check is missing: ${name}`);
    } else if (check.headSha !== input.expectedHeadSha) {
      reasons.push(`Required check is stale: ${name}`);
    } else if (check.status !== "succeeded") {
      reasons.push(
        `Required check is not successful: ${name} (${check.status})`,
      );
    }
  }
  for (const check of input.checks) {
    if (!input.requiredCheckNames.includes(check.name)) {
      reasons.push(`Unexpected required check result: ${check.name}`);
    }
  }
  const local = decideVerifiedPublication({
    ...input.localEvidence,
    currentContentIdentity: input.localEvidence.currentContentIdentity,
  });
  reasons.push(...local.reasons);
  return {
    allowed: reasons.length === 0,
    reasons,
    headSha: input.expectedHeadSha,
  };
}
