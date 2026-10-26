import type { ImplementationReviewResult } from "./implementation-review-result.js";
import type { TaskSessionValidationResult } from "./run-task-session-validation.js";

export interface VerifiedPublicationDecisionInput {
  currentContentIdentity: string;
  validationCommand: string;
  validation: TaskSessionValidationResult | null;
  coverageCommand?: string;
  coverage: TaskSessionValidationResult | null;
  review: ImplementationReviewResult | null;
}

export interface VerifiedPublicationDecision {
  allowed: boolean;
  reasons: string[];
  contentIdentity: string;
}

/** Pure gate: publication may start only when every configured gate passes on the current snapshot. */
export function decideVerifiedPublication(
  input: VerifiedPublicationDecisionInput,
): VerifiedPublicationDecision {
  const reasons: string[] = [];
  const identity = input.currentContentIdentity;

  if (identity.trim().length === 0) {
    reasons.push("Current source content identity is missing");
  }

  if (input.validationCommand.trim().length === 0) {
    reasons.push("Configured validation command is missing");
  }

  if (input.validation === null) {
    reasons.push("Successful local validation evidence is missing");
  } else {
    if (
      input.validation.status !== "passed" ||
      input.validation.exitCode !== 0 ||
      input.validation.timedOut ||
      input.validation.aborted
    ) {
      reasons.push("Local validation did not pass");
    }
    if (input.validation.command !== input.validationCommand) {
      reasons.push("Local validation command does not match configuration");
    }
    if (input.validation.contentIdentity !== identity) {
      reasons.push("Local validation evidence is stale");
    }
  }

  if (input.coverageCommand === undefined) {
    if (input.coverage !== null) {
      reasons.push(
        "Coverage evidence was supplied without a configured command",
      );
    }
  } else if (input.coverage === null) {
    reasons.push("Configured coverage evidence is missing");
  } else {
    if (
      input.coverage.status !== "passed" ||
      input.coverage.exitCode !== 0 ||
      input.coverage.timedOut ||
      input.coverage.aborted
    ) {
      reasons.push("Configured coverage did not pass");
    }
    if (input.coverage.command !== input.coverageCommand) {
      reasons.push("Coverage command does not match configuration");
    }
    if (input.coverage.contentIdentity !== identity) {
      reasons.push("Coverage evidence is stale");
    }
  }

  if (input.review === null) {
    reasons.push("Passing final implementation review is missing");
  } else {
    if (input.review.verdict !== "pass") {
      reasons.push("Final implementation review did not pass");
    }
    if (input.review.reviewedContentIdentity !== identity) {
      reasons.push("Final implementation review is stale");
    }
  }

  return { allowed: reasons.length === 0, reasons, contentIdentity: identity };
}

/**
 * Human-review PR creation is delivery, not quality approval. Report failed,
 * missing, or stale gates in the decision reasons, but do not use them to
 * prevent a safely owned implementation from reaching human review.
 *
 * Callers must independently verify Git ownership, commit integrity, and
 * destination. Auto-merge must use decideVerifiedPublication instead.
 */
export function decideHumanReviewPublication(
  input: VerifiedPublicationDecisionInput,
  _exhaustedReview: ImplementationReviewResult | undefined,
  _options: { allowStaleExhaustedReview?: boolean } = {},
): VerifiedPublicationDecision {
  const decision = decideVerifiedPublication(input);
  const staleReasons = [
    "Local validation evidence is stale",
    "Coverage evidence is stale",
    ...(_options.allowStaleExhaustedReview === true &&
    _exhaustedReview !== undefined &&
    input.review !== null &&
    JSON.stringify(input.review) === JSON.stringify(_exhaustedReview)
      ? []
      : ["Final implementation review is stale"]),
  ];
  return {
    ...decision,
    allowed:
      input.currentContentIdentity.trim().length > 0 &&
      !decision.reasons.some((reason) => staleReasons.includes(reason)),
  };
}
