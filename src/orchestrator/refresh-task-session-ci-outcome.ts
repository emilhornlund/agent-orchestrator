import type { ProjectConfig } from "../config/config.js";
import type { GitHubClient } from "../github/github-client.js";
import type { CiCheckEvaluation } from "../github/evaluate-ci-checks.js";
import type { TrelloCard } from "../trello/trello-client.js";
import type { TaskExecutionRecord } from "../task-session/task-execution-record.js";
import type { PrMaintenanceStore } from "../task-session/pr-maintenance-store.js";
import { refreshPrAutomationOutcome } from "./refresh-pr-automation-outcome.js";
import { decideValidatedHumanReviewPublication } from "../task-session/verified-publication-decision.js";
import { restorePersistedTaskSessionQualityEvidence } from "../task-session/run-task-session-validation.js";
import {
  recordedTaskQualityFacts,
  maintenanceQualityFacts,
  ciOutcomeFacts,
  repairSummary,
} from "./publication-quality-summary.js";
import { implementationReviewResultSchema } from "../task-session/implementation-review-result.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { FeedbackLedgerStore } from "../task-session/feedback-ledger-store.js";
import { isOutstandingFeedback } from "../task-session/feedback-ledger.js";

/** Repeatable presentation has no AI dispatch and can recover after a no-op or exhausted episode. */
export async function refreshTaskSessionCiOutcome(options: {
  project: ProjectConfig;
  card: TrelloCard;
  github: GitHubClient;
  record: TaskExecutionRecord;
  maintenanceStore: PrMaintenanceStore;
  evaluation: CiCheckEvaluation;
}): Promise<void> {
  const { record, evaluation, github, project, card } = options;
  if (!record.pullRequest || record.pullRequest.headSha !== evaluation.expectedHeadSha)
    throw new Error("CI outcome does not belong to the published PR revision");
  // Older in-process callers may have no description capability. The concrete
  // GitHub client always supplies it; remote errors are never silently skipped.
  if (
    typeof github.getPullRequestDescription !== "function" ||
    typeof github.editPullRequestDescription !== "function" ||
    typeof github.ensurePullRequestDraft !== "function"
  )
    return;
  const maintenance = options.maintenanceStore
    .inspect()
    .reverse()
    .find(
      (operation) =>
        operation.strategy === "merge" &&
        operation.localPreparation?.resultingHead === record.pullRequest!.headSha,
    );
  const episode = record.ciRepair;
  const quality = record.publicationQuality;
  const retainedReview = record.reviewRepair?.finalReview;
  const reusableReview =
    retainedReview?.reviewedContentIdentity === quality?.contentIdentity
      ? retainedReview
      : undefined;
  const review = implementationReviewResultSchema.safeParse(quality?.review ?? reusableReview);
  const qualityUnresolved = maintenance
    ? maintenance.qualityVerification?.status !== "passed"
    : !quality ||
      !decideValidatedHumanReviewPublication({
        currentContentIdentity: quality.contentIdentity,
        ...(project.repository.validationCommand === undefined
          ? {}
          : { validationCommand: project.repository.validationCommand }),
        ...(project.repository.coverageCommand === undefined
          ? {}
          : { coverageCommand: project.repository.coverageCommand }),
        validation: restorePersistedTaskSessionQualityEvidence(quality.validation),
        coverage:
          quality.coverageEvidence === undefined
            ? null
            : restorePersistedTaskSessionQualityEvidence(quality.coverageEvidence),
        review: null,
      }).allowed ||
      !review.success ||
      review.data.reviewedContentIdentity !== quality.contentIdentity ||
      review.data.verdict === "fail";
  const authority = ProjectRunAuthority.current(project.id);
  const feedback = authority
    ? new FeedbackLedgerStore(authority.store.storageRoot, project, authority).read(card.id)
    : null;
  const unresolvedHumanRequests = feedback?.entries.some(isOutstandingFeedback) ?? false;
  const ciWaitExpired =
    record.ciObservationWindow?.headSha === record.pullRequest.headSha &&
    record.ciObservationWindow?.timedOut === true;
  const requiresDraft =
    qualityUnresolved ||
    unresolvedHumanRequests ||
    evaluation.status === "failed" ||
    (evaluation.status === "uncertain" && (evaluation.failures?.length ?? 0) > 0) ||
    (evaluation.status !== "passed" && ciWaitExpired);
  await refreshPrAutomationOutcome({
    github,
    project,
    card,
    pullRequestUrl: record.pullRequest.url,
    headSha: record.pullRequest.headSha!,
    // Pending registration or execution is not a reason to downgrade a normal
    // PR. Neither pending nor uncertain evidence can promote an existing draft.
    ...(requiresDraft ? { draft: true } : evaluation.status === "passed" ? { draft: false } : {}),
    ...(authority && record.expectedBranch && typeof github.ensurePullRequestReady === "function"
      ? {
          readiness: {
            headBranch: record.expectedBranch,
          },
        }
      : {}),
    facts: [
      ...ciOutcomeFacts(evaluation),
      ...(unresolvedHumanRequests
        ? ["Human-requested changes remain unresolved or unverified."]
        : []),
      ...(ciWaitExpired
        ? ["The wait for CI results ended before all checks could be verified."]
        : []),
      ...(episode
        ? [
            repairSummary(
              "CI remediation",
              record.retryCounters.ci,
              episode.maxAttempts ?? 2,
              episode.stopReason ?? (episode.status === "passed" ? "passed" : undefined),
            ),
          ]
        : []),
      ...(maintenance
        ? maintenanceQualityFacts(project, maintenance.qualityVerification)
        : recordedTaskQualityFacts(project, record)),
    ],
  });
}
