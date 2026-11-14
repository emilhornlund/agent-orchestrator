import { stripVTControlCharacters } from "node:util";
import { redactSecrets } from "../security/redact-secrets.js";
import { getProcessRuntime } from "../process/process-runtime.js";
import type { VerifiedPublicationDecisionInput } from "../task-session/verified-publication-decision.js";
import type { TaskSessionValidationResult } from "../task-session/run-task-session-validation.js";
import type { CiCheckEvaluation } from "../github/evaluate-ci-checks.js";
import type { FeedbackDisposition } from "../task-session/feedback-verification.js";

function line(value: string, maximum = 480): string {
  return redactSecrets(stripVTControlCharacters(value), getProcessRuntime().secretValues)
    .replace(/<!--[\s\S]*?-->/gu, "[managed marker]")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}
function quality(
  label: string,
  result: TaskSessionValidationResult | null,
  identity: string,
  configured?: string,
): string {
  if (!result)
    return `${label}: ${configured === undefined ? "not configured; no check executed" : "unavailable; configured check not verified"}.`;
  const status =
    result.status === "skipped" && result.command === "" && configured === undefined
      ? "Not configured; skipped"
      : result.status;
  const command = result.command === "" ? "" : `; command: ${line(result.command, 240)}`;
  const exit =
    result.exitCode === null ? "; exit status unavailable" : `; exit code ${result.exitCode}`;
  const stale =
    result.contentIdentity === identity ? "" : "; evidence belongs to an earlier source snapshot";
  const mismatch =
    configured === undefined && result.command !== ""
      ? "; check not configured in current settings"
      : configured !== undefined && configured !== result.command
        ? "; recorded command differs from current configuration"
        : "";
  return line(`${label}: ${status}${command}${exit}${stale}${mismatch}.`);
}

/** Render only observed domain facts. Raw command diagnostics stay in retained
 * process/session artifacts, never embedded as terminal output or result JSON. */
export function publicationQualityFacts(
  input: VerifiedPublicationDecisionInput,
  options: {
    planAvailable?: boolean;
    diagnosticLog?: string;
  } = {},
): string[] {
  const facts = [
    ...(options.planAvailable === undefined
      ? []
      : [
          `Advisory implementation plan: ${options.planAvailable ? "available" : "unavailable; original task remains the scope"}.`,
        ]),
    quality("Validation", input.validation, input.currentContentIdentity, input.validationCommand),
    quality("Coverage", input.coverage, input.currentContentIdentity, input.coverageCommand),
  ];
  facts.push(
    input.review === null
      ? "Independent AI review: unavailable; not represented as passed."
      : line(
          `Independent AI review: advisory ${input.review.verdict}; reported findings: ${input.review.blockingFindings.length}; unsatisfied requirements: ${input.review.requirementAssessments.filter((item) => item.status === "unsatisfied").length}${input.review.reviewedContentIdentity === input.currentContentIdentity ? "" : "; earlier source snapshot"}. See outstanding issues for current dispositions.`,
        ),
  );
  facts.push(line(`Source snapshot: ${input.currentContentIdentity}.`));
  if (options.diagnosticLog)
    facts.push(
      line(
        `Diagnostics: ${options.diagnosticLog}; complete stdout/stderr are retained separately.`,
      ),
    );
  return facts;
}

export function ciOutcomeFacts(evaluation: CiCheckEvaluation): string[] {
  const names = (values: readonly string[]) =>
    line(
      values.slice(0, 10).join(", ") + (values.length > 10 ? `; ${values.length - 10} more` : ""),
      320,
    );
  const facts = [
    `Observed CI for this revision: ${evaluation.status}; revision: ${evaluation.expectedHeadSha}.`,
  ];
  if (evaluation.status === "passed")
    facts.push(`Expected checks passed: ${names(evaluation.expectedCheckNames)}.`);
  else if (evaluation.status === "failed") {
    facts.push(
      `Failed checks: ${names(evaluation.failures.map((check) => (check.source === "check-run" ? check.name : check.context)))}.`,
    );
    if (evaluation.missingChecks?.length)
      facts.push(`Expected checks not yet observed: ${names(evaluation.missingChecks)}.`);
    if (evaluation.pendingChecks?.length)
      facts.push(`Pending checks: ${names(evaluation.pendingChecks)}.`);
  } else if (evaluation.status === "waiting") {
    if (evaluation.missingChecks.length)
      facts.push(`Expected checks not yet observed: ${names(evaluation.missingChecks)}.`);
    if (evaluation.pendingChecks.length)
      facts.push(`Pending checks: ${names(evaluation.pendingChecks)}.`);
    facts.push(line(`CI observation: ${evaluation.diagnostic}`));
  } else facts.push(line(`CI uncertainty: ${evaluation.diagnostic}`));
  return facts.map((fact) => line(fact));
}

export function feedbackDispositionFacts(dispositions: readonly FeedbackDisposition[]): string[] {
  const facts = [
    `Human feedback: ${dispositions.filter((item) => item.status === "verified-fixed").length} verified fixed; ${dispositions.filter((item) => item.status === "unresolved").length} unresolved; ${dispositions.filter((item) => item.status === "uncertain").length} uncertain.`,
  ];
  const outstanding = dispositions.filter((entry) => entry.status !== "verified-fixed");
  for (const item of outstanding.slice(0, 5))
    facts.push(
      line(
        `Feedback ${item.feedbackId}: ${item.status}${"reason" in item ? `; ${item.reason}` : ""}`,
      ),
    );
  if (outstanding.length > 5)
    facts.push(
      `${outstanding.length - 5} further unresolved or uncertain requests remain in the retained feedback ledger and task diagnostics.`,
    );
  return facts;
}
