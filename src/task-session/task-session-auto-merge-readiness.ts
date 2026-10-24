import type { CiCheckEvaluation } from "../github/evaluate-ci-checks.js";
import {
  decideVerifiedPublication,
  type VerifiedPublicationDecisionInput,
} from "./verified-publication-decision.js";

export interface TaskSessionAutoMergeReadinessInput {
  expectedHeadSha: string;
  observedHeadSha: string;
  ciEvaluation: CiCheckEvaluation;
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
    input.ciEvaluation.status !== "passed" ||
    input.ciEvaluation.expectedHeadSha !== input.expectedHeadSha
  ) {
    reasons.push(
      input.ciEvaluation.status === "waiting" ||
        input.ciEvaluation.status === "uncertain"
        ? `Complete current-head CI evidence is unavailable: ${input.ciEvaluation.diagnostic}`
        : input.ciEvaluation.status === "failed"
          ? "Current-head CI contains terminal failures"
          : "CI evidence does not match the expected PR head",
    );
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
