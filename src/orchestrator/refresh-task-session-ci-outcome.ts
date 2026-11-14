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
  implementationReviewResultSchema,
  hasUndisposedReviewConcerns,
} from "../task-session/implementation-review-result.js";

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
  const review = implementationReviewResultSchema.safeParse(quality?.review);
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
      hasUndisposedReviewConcerns(
        review.data,
        record.reviewRepair?.findings ?? [],
        record.reviewRepair?.requirementDispositions ?? [],
      );
  await refreshPrAutomationOutcome({
    github,
    project,
    card,
    pullRequestUrl: record.pullRequest.url,
    headSha: record.pullRequest.headSha!,
    draft:
      evaluation.status !== "passed" ||
      qualityUnresolved ||
      ["exhausted", "stopped"].includes(episode?.status ?? ""),
    facts: [
      `Observed CI for this revision: ${JSON.stringify(evaluation)}`,
      ...(record.ciObservationWindow?.headSha === record.pullRequest.headSha &&
      record.ciObservationWindow.timedOut
        ? [
            "The bounded CI observation deadline expired. Missing, pending or undiscovered checks remain uncertain, not passed.",
          ]
        : []),
      ...(episode
        ? [
            `CI episode: ${JSON.stringify({ id: episode.cycleId, trigger: episode.initiatingEventId, status: episode.status, attempts: record.retryCounters.ci, maximum: episode.maxAttempts ?? 2, stopReason: episode.stopReason })}`,
          ]
        : []),
      ...(episode?.stopReason === "no-change"
        ? [
            "The CI correction produced no repository changes; no new commit, validation run or fulfilled fix is claimed.",
          ]
        : []),
      ...(maintenance
        ? [
            `Target synchronization merged ${maintenance.targetBaseHead} into ${maintenance.expectedRemoteHead} without rewriting published commits.`,
            `Maintenance quality evidence: ${JSON.stringify(maintenance.qualityVerification)}`,
          ]
        : [
            `Recorded local quality evidence (identified by source snapshot): ${JSON.stringify(record.publicationQuality ?? { status: "unavailable" })}`,
          ]),
      "AI advice is not approval to merge. Human merge or closure controls the task outcome.",
    ],
  });
}
