import { stripVTControlCharacters } from "node:util";
import { redactSecrets } from "../security/redact-secrets.js";
import { getProcessRuntime } from "../process/process-runtime.js";
import type { VerifiedPublicationDecisionInput } from "../task-session/verified-publication-decision.js";
import type { TaskSessionValidationResult } from "../task-session/run-task-session-validation.js";
import type { CiCheckEvaluation } from "../github/evaluate-ci-checks.js";
import type { FeedbackDisposition } from "../task-session/feedback-verification.js";
import type { ImplementationReviewResult } from "../task-session/implementation-review-result.js";
import type { TaskExecutionRecord } from "../task-session/task-execution-record.js";
import type { ProjectConfig } from "../config/config.js";
import type { PrMaintenanceOperation } from "../task-session/pr-maintenance-operation.js";
import { implementationReviewResultSchema } from "../task-session/implementation-review-result.js";
import { restorePersistedTaskSessionQualityEvidence } from "../task-session/run-task-session-validation.js";

function line(value: string): string {
  return redactSecrets(stripVTControlCharacters(value), getProcessRuntime().secretValues)
    .replace(/<!--[\s\S]*?-->/gu, "[managed marker]")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
function quality(
  label: string,
  result: Pick<TaskSessionValidationResult, "command" | "status" | "contentIdentity"> | null,
  identity: string,
  configured?: string,
): string {
  if (configured === undefined) return `${label}: skipped (not configured).`;
  if (!result) return `${label}: unavailable.`;
  if (result.contentIdentity !== identity || configured !== result.command)
    return `${label}: outdated (no result for the current changes and configuration).`;
  const status = {
    "timed-out": "unavailable (timed out)",
    aborted: "unavailable (interrupted)",
    uncertain: "unavailable (not verified)",
  };
  return `${label}: ${status[result.status as keyof typeof status] ?? result.status}.`;
}

export function recordedTaskQualityFacts(
  project: ProjectConfig,
  record: TaskExecutionRecord,
): string[] {
  const evidence = record.publicationQuality;
  const review = implementationReviewResultSchema.safeParse(
    evidence?.review ?? (record.reviewUnavailable ? null : record.reviewRepair?.finalReview),
  );
  const prior = record.reviewUnavailable?.priorReview;
  const identity = evidence?.contentIdentity ?? "";
  return [
    ...publicationQualityFacts({
      currentContentIdentity: identity,
      validation: evidence ? restorePersistedTaskSessionQualityEvidence(evidence.validation) : null,
      coverage: evidence?.coverageEvidence
        ? restorePersistedTaskSessionQualityEvidence(evidence.coverageEvidence)
        : null,
      review: review.success ? review.data : null,
      ...(project.repository.validationCommand === undefined
        ? {}
        : { validationCommand: project.repository.validationCommand }),
      ...(project.repository.coverageCommand === undefined
        ? {}
        : { coverageCommand: project.repository.coverageCommand }),
    }),
    ...taskRepairFacts(record),
    ...reviewConcernFacts(
      review.success ? review.data : prior,
      !review.success || review.data.reviewedContentIdentity !== identity,
    ),
  ];
}

export function maintenanceQualityFacts(
  project: ProjectConfig,
  evidence: PrMaintenanceOperation["qualityVerification"],
): string[] {
  function check(value: unknown): Parameters<typeof quality>[1] {
    if (
      typeof value !== "object" ||
      value === null ||
      !("command" in value) ||
      typeof value.command !== "string" ||
      !("contentIdentity" in value) ||
      typeof value.contentIdentity !== "string" ||
      !("status" in value)
    )
      return null;
    const status = value.status;
    if (
      status !== "passed" &&
      status !== "failed" &&
      status !== "skipped" &&
      status !== "uncertain" &&
      status !== "aborted" &&
      status !== "timed-out"
    )
      return null;
    return { command: value.command, contentIdentity: value.contentIdentity, status };
  }
  const identity = evidence?.contentIdentity ?? "";
  const review = implementationReviewResultSchema.safeParse(evidence?.review);
  return [
    "Branch updated from the target branch without rewriting published commits.",
    quality(
      "Validation",
      check(evidence?.validation),
      identity,
      project.repository.validationCommand,
    ),
    quality("Coverage", check(evidence?.coverage), identity, project.repository.coverageCommand),
    `Independent AI review: ${!review.success ? "unavailable" : review.data.reviewedContentIdentity !== identity ? "outdated" : review.data.verdict === "pass" ? "passed" : "failed; material concerns remain"}.`,
    ...reviewConcernFacts(review.data, review.data?.reviewedContentIdentity !== identity),
  ];
}

/** Render only observed domain facts. Raw command diagnostics stay in retained
 * process/session artifacts, never embedded as terminal output or result JSON. */
export function publicationQualityFacts(
  input: VerifiedPublicationDecisionInput,
  options: { reviewSkipped?: boolean } = {},
): string[] {
  return [
    quality("Validation", input.validation, input.currentContentIdentity, input.validationCommand),
    quality("Coverage", input.coverage, input.currentContentIdentity, input.coverageCommand),
    input.review === null
      ? `Independent AI review: ${options.reviewSkipped ? "skipped" : "unavailable"}.`
      : input.review.reviewedContentIdentity !== input.currentContentIdentity
        ? "Independent AI review: outdated."
        : `Independent AI review: ${input.review.verdict === "pass" ? "passed" : "failed; material concerns remain"}.`,
  ];
}

/** Combine a finding and its related unmet requirements. Keep complete entries;
 * if the PR budget is exceeded, count explicitly what could not be shown. */
export function reviewConcernFacts(
  review: ImplementationReviewResult | null | undefined,
  outdated = false,
): string[] {
  if (review?.verdict !== "fail") return [];
  const unmet = new Map(
    review.requirementAssessments
      .filter(({ status }) => status === "unsatisfied")
      .map((item) => [item.requirementId, item]),
  );
  const linked = new Set<string>();
  const requirementText = (item: NonNullable<ReturnType<typeof unmet.get>>): string =>
    line(item.requirement ?? item.details);
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const finding of review.blockingFindings) {
    const { summary, detail, location, recommendation } = finding;
    const key = JSON.stringify([summary, detail, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const requirements = [...new Set(finding.requirementIds ?? [])].flatMap((id) => {
      const item = unmet.get(id);
      return item && !linked.has(id) ? [item] : [];
    });
    const entry = line(
      [
        `**${summary}** — ${detail}`,
        location &&
          `Location: \`${location.filePath}${location.line === undefined ? "" : `:${location.line}`}\`.`,
        recommendation && `Suggested correction: ${recommendation}`,
        requirements.length &&
          `Unmet requirements: ${requirements.map(requirementText).join("; ")}`,
      ]
        .filter(Boolean)
        .join(" "),
    );
    if (entry.length <= 8_000) {
      entries.push(entry);
      for (const item of requirements) linked.add(item.requirementId);
    } else {
      const brief = line(
        [
          `**${summary}**`,
          location &&
            `Location: \`${location.filePath}${location.line === undefined ? "" : `:${location.line}`}\`.`,
          recommendation && `Suggested correction: ${recommendation}`,
        ]
          .filter(Boolean)
          .join(" — "),
      );
      entries.push(
        brief.length <= 8_000
          ? `${brief} Additional details omitted for length.`
          : "A material finding is too long to display here.",
      );
    }
  }
  for (const [id, item] of unmet) {
    if (linked.has(id)) continue;
    const details =
      item.requirement && item.requirement !== item.details ? ` — ${line(item.details)}` : "";
    const requirement = `Unmet requirement: ${requirementText(item)}`;
    entries.push(
      requirement.length + details.length <= 8_000
        ? requirement + details
        : requirement.length <= 8_000
          ? `${requirement} Assessment details omitted for length.`
          : "An unmet requirement is too long to display here.",
    );
  }
  const visible: string[] = [];
  let length = 0;
  for (const entry of new Set(entries)) {
    if (length + entry.length > 24_000 || visible.length >= 20) break;
    visible.push(entry);
    length += entry.length;
  }
  const omitted = new Set(entries).size - visible.length;
  return [
    outdated
      ? "Earlier review concerns (not verified against the current changes):"
      : "Outstanding review findings:",
    ...visible,
    ...(omitted > 0 ? [`${omitted} additional review concerns omitted for length.`] : []),
  ];
}

/** Short publication notices link to the PR for the full explanation. */
export function reviewNotificationConcerns(
  review: ImplementationReviewResult | null | undefined,
): string[] {
  if (review?.verdict !== "fail") return [];
  const concerns = new Set([
    ...review.blockingFindings.map(({ summary }) => line(summary)),
    ...(!review.blockingFindings.length
      ? review.requirementAssessments.flatMap(({ status, requirement, details }) =>
          status === "unsatisfied" ? [line(requirement ?? details)] : [],
        )
      : []),
  ]);
  const visible = [...concerns].filter((concern) => concern.length <= 200).slice(0, 3);
  if (visible.length < concerns.size)
    visible.push(`${concerns.size - visible.length} more review concerns; see the PR.`);
  return visible;
}

export function repairSummary(
  label: string,
  used: number,
  maximum: number,
  reason?: string,
): string {
  const reasons: Record<string, string> = {
    "attempt-limit": "attempt limit reached",
    "no-change": "stopped because the repair left the source unchanged",
    "finished-early": "stopped at the agent’s request before this workflow was upgraded",
    "review-unavailable": "a follow-up review could not be completed",
    "validation-exhausted": "local checks still failed",
    "prepared-check-failed": "checks failed on the prepared changes",
    passed: "checks passed",
  };
  return `${label}: ${used} of ${maximum} attempts used${reason && reasons[reason] ? `; ${reasons[reason]}` : ""}.`;
}

export function taskRepairFacts(
  record: TaskExecutionRecord | null,
  options: { review?: boolean; validation?: boolean } = {},
): string[] {
  if (!record) return [];
  const { reviewRepair, validationRepair, retryCounters } = record;
  return [
    ...(options.review !== false &&
    reviewRepair?.maxAttempts !== undefined &&
    (retryCounters.review > 0 || reviewRepair.stopReason)
      ? [
          repairSummary(
            "Review remediation",
            retryCounters.review,
            reviewRepair.maxAttempts,
            reviewRepair.stopReason ?? (reviewRepair.status === "passed" ? "passed" : undefined),
          ),
        ]
      : []),
    ...(options.validation !== false &&
    validationRepair?.maxAttempts !== undefined &&
    (retryCounters.validation > 0 || validationRepair.stopReason)
      ? [
          repairSummary(
            "Local check remediation",
            retryCounters.validation,
            validationRepair.maxAttempts,
            validationRepair.stopReason ??
              (validationRepair.status === "passed" ? "passed" : undefined),
          ),
        ]
      : []),
  ];
}

export function ciOutcomeFacts(evaluation: CiCheckEvaluation): string[] {
  if (evaluation.status === "passed")
    return [`CI: passed (${evaluation.expectedCheckNames.length} expected checks).`];
  const status = { failed: "failed", waiting: "pending", uncertain: "unavailable" }[
    evaluation.status
  ];
  const failed =
    evaluation.status === "waiting"
      ? []
      : (evaluation.failures?.map((check) =>
          line(check.source === "check-run" ? check.name : check.context),
        ) ?? []);
  const displayed = failed.filter((name) => name.length <= 160).slice(0, 5);
  const failureNote = [
    ...displayed,
    ...(failed.length > displayed.length ? [`${failed.length - displayed.length} more`] : []),
  ].join(", ");
  const counts = [
    evaluation.pendingChecks?.length && `${evaluation.pendingChecks.length} pending`,
    evaluation.missingChecks?.length && `${evaluation.missingChecks.length} not yet observed`,
  ]
    .filter(Boolean)
    .join(", ");
  return [
    `CI: ${status}${failureNote ? `; failed checks: ${failureNote}` : ""}${counts ? `; ${counts}` : ""}.`,
  ];
}

export function feedbackDispositionFacts(dispositions: readonly FeedbackDisposition[]): string[] {
  const facts = [
    `Human feedback: ${dispositions.filter((item) => item.status === "verified-fixed").length} verified fixed; ${dispositions.filter((item) => item.status === "unresolved").length} unresolved; ${dispositions.filter((item) => item.status === "uncertain").length} uncertain.`,
  ];
  const outstanding = dispositions.filter((entry) => entry.status !== "verified-fixed");
  for (const item of outstanding.slice(0, 5))
    facts.push(
      line(
        `Human request ${item.status === "uncertain" ? "not verified" : "unresolved"}${"reason" in item ? `: ${item.reason}` : "."}`,
      ),
    );
  if (outstanding.length > 5)
    facts.push(
      `${outstanding.length - 5} more unresolved or unverified requests; see the PR discussion.`,
    );
  return facts;
}
