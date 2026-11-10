import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import { buildPullRequestAttributionFooter } from "../github/pull-request-attribution.js";
import type { ImplementationReviewResult } from "../task-session/implementation-review-result.js";
import { reviewConcernsDismissedAsNonMaterialLabel } from "../task-session/implementation-review-result.js";
import { enrichPullRequestDescription } from "../github/enrich-pull-request-description.js";
import { logger } from "../logging/logger.js";
import { getSessionLogPath } from "../logging/session-log.js";
import {
  notifyHumanReview,
  enqueueNotification,
  buildHumanReviewEmail,
  publicationNotificationIssues,
  type EmailNotifier,
} from "../notifications/email-notifier.js";
import {
  TrelloRequestAbortedError,
  type TrelloCard,
  type TrelloClient,
} from "../trello/trello-client.js";
import { buildPullRequestDescriptionPrompt } from "../opencode/build-pull-request-description-prompt.js";
import {
  captureRepositorySnapshot,
  repositorySnapshotsEqual,
} from "../opencode/commit-result.js";
import {
  type OpenCodeClient,
  type OpenCodeRunResult,
} from "../opencode/opencode-client.js";
import {
  parsePullRequestDescription,
  PullRequestDescriptionParseError,
  type PullRequestDescription,
} from "../opencode/pull-request-description.js";
import { renderPullRequestDescription } from "../opencode/render-pull-request-description.js";
import type { CommandRunner } from "../process/command-runner.js";
import type { PersistedSetupDisposition } from "../process/setup-commit-scope.js";

import { toFailureError } from "./failure-diagnostic.js";
import { PublishedCardStateError } from "./published-card-state-error.js";
import { getElapsedWorkflowTime } from "./workflow-duration.js";
import { WorkflowError } from "./workflow-error.js";
import { writeTrustedCommitState } from "./trusted-commit-state.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import {
  resumeInitialPublication,
  PublicationWaitingError,
} from "./initial-publication.js";

export interface PublishCardOptions {
  trello: TrelloClient;
  git: GitClient;
  github: GitHubClient;
  opencode?: OpenCodeClient;
  project: ProjectConfig;
  card: TrelloCard;
  worktreePath: string;
  branch: string;
  commitSha: string;
  reviewResult: string;
  remediationResult: string;
  exhaustedReview?: ImplementationReviewResult | undefined;
  pullRequestDescription?: PullRequestDescription;
  sessionLogPath?: string;
  emailNotifier?: EmailNotifier;
  claimHumanReviewNotification?: (commitSha: string) => boolean;
  signal?: AbortSignal;
  commands?: CommandRunner;
  rebaseAlreadyCompleted?: boolean;
  beforePushVerification?: () => Promise<PreparedReviewPublication | void>;
  expectedExistingPullRequestUrl?: string;
  verifiedDescriptionFacts?: () => readonly string[];
  setupDisposition?: PersistedSetupDisposition;
  /** Non-passing or skipped local checks require draft publication. */
  qualityNeedsDraft?: boolean;
}

export interface PreparedReviewPublication {
  reviewResult: string;
  /** Current-source material concerns to disclose and use for draft selection. */
  reviewDisclosure: ImplementationReviewResult | null;
  qualityNeedsDraft?: boolean;
}

function appendVerifiedWorkflowEvidence(
  body: string,
  verifiedFacts: readonly string[],
): string {
  if (verifiedFacts.length === 0) return body;
  const section = `## Orchestrator-observed workflow evidence\n${verifiedFacts
    .map((fact) => `- ${fact.replace(/[\r\n]+/gu, " ")}`)
    .join("\n")}`;
  return body.includes(section) ? body : `${body}\n\n${section}`;
}

/** Presentation is finalized before the durable payload is hashed. Recovery
 * uses that exact body and never asks an agent to regenerate dispatched text. */
export async function prepareInitialPublicationBody(
  options: Omit<PublishCardOptions, "commitSha">,
  generateDescription = true,
): Promise<string> {
  let description = options.pullRequestDescription;
  const verifiedFacts = options.verifiedDescriptionFacts?.() ?? [];
  if (options.opencode && generateDescription)
    description = await generatePullRequestDescription({
      git: options.git,
      opencode: options.opencode,
      project: options.project,
      card: options.card,
      worktreePath: options.worktreePath,
      commitSha: await options.git.getHeadSha(options.worktreePath),
      reviewResult: options.reviewResult,
      remediationResult: options.remediationResult,
      signal: options.signal ?? new AbortController().signal,
      verifiedFacts,
      cardLog: logger.child({
        projectId: options.project.id,
        cardId: options.card.id,
      }),
    });
  let body = renderDeterministicPullRequestBody(
    options.card,
    options.project.repository.gitIdentity.name,
  );
  if (description)
    body = renderPullRequestDescription(
      verifiedFacts.length
        ? description
        : {
            ...description,
            validation: [
              "No verified validation or test results are available.",
            ],
          },
      options.card,
      options.project.repository.gitIdentity.name,
    );
  body = appendVerifiedWorkflowEvidence(body, verifiedFacts);
  body += `\n\nReview: ${options.reviewResult}\nRemediation: ${options.remediationResult}`;
  if (options.exhaustedReview) {
    body += `\n\n## Automated review — human action required\nThis PR has **not** passed automated review.\n${options.exhaustedReview.blockingFindings
      .slice(0, 20)
      .map(
        (finding) =>
          `> ${[finding.summary, finding.detail].join(": ").replace(/\s+/gu, " ").slice(0, 400)}`,
      )
      .join("\n")}`;
    body += options.exhaustedReview.requirementAssessments
      .filter((assessment) => assessment.status === "unsatisfied")
      .map(
        (assessment) =>
          `\n> Unsatisfied requirement: ${assessment.requirementId}`,
      )
      .join("");
  }
  return body;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderDeterministicPullRequestBody(
  card: TrelloCard,
  gitIdentityName: string,
): string {
  return [
    `Trello: ${card.url}`,
    "",
    buildPullRequestAttributionFooter(gitIdentityName),
  ].join("\n");
}

function logDescriptionFallback(
  cardLog: ReturnType<typeof logger.child>,
  stage: string,
  error: unknown,
  attempt?: "initial attempt" | "corrective retry",
  processExecutionId?: string,
): void {
  const failureType =
    error instanceof PullRequestDescriptionParseError
      ? error.failureType
      : "execution-failure";
  const attemptText = attempt === undefined ? "" : ` on ${attempt}`;
  const artifactRef = processExecutionId
    ? `; process execution: process-executions/${processExecutionId}`
    : "; process execution log reference unavailable";

  cardLog.warn(
    `Pull request description generation failed${attemptText} during ${stage} (${failureType})${artifactRef}. Using deterministic fallback pull request body.`,
  );
}

async function generatePullRequestDescription(options: {
  git: GitClient;
  opencode: OpenCodeClient;
  project: ProjectConfig;
  card: TrelloCard;
  worktreePath: string;
  commitSha: string;
  reviewResult: string;
  remediationResult: string;
  signal: AbortSignal;
  sessionLogPath?: string;
  verifiedFacts: readonly string[];
  cardLog: ReturnType<typeof logger.child>;
}): Promise<PullRequestDescription | undefined> {
  const {
    git,
    opencode,
    project,
    card,
    worktreePath,
    commitSha,
    reviewResult,
    remediationResult,
    verifiedFacts,
    signal,
    sessionLogPath,
    cardLog,
  } = options;

  let changedFiles: string;
  let commitMessage: string;

  try {
    changedFiles = await git.getChangedFiles(
      worktreePath,
      `origin/${project.repository.defaultBranch}`,
    );
    commitMessage = await git.getCommitMessage(worktreePath);
  } catch (error) {
    if (signal.aborted) {
      throw new TrelloRequestAbortedError();
    }

    logDescriptionFallback(cardLog, "final commit context collection", error);
    return undefined;
  }

  cardLog.event("Starting OpenCode pull request description generation...");

  const descriptionPrompt = buildPullRequestDescriptionPrompt(card, {
    changedFiles,
    commitSha,
    commitMessage,
    ...(project.repository.validationCommand === undefined
      ? {}
      : { validationCommand: project.repository.validationCommand }),
    workflowResults: [
      `Automated review result: ${reviewResult}.`,
      `Automated remediation result: ${remediationResult}.`,
    ],
    verifiedFacts,
  });

  const runDescription = async (
    prompt: string,
    failureStage: string,
    attempt: "initial attempt" | "corrective retry",
  ): Promise<OpenCodeRunResult | undefined> => {
    let result: OpenCodeRunResult;

    try {
      result = await opencode.run({
        cwd: worktreePath,
        model: project.opencode.commit.model,
        variant: project.opencode.commit.variant,
        timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
        prompt,
        signal,
        readOnly: true,
        sessionLogPath:
          sessionLogPath ?? getSessionLogPath(project.id, card.id),
        sessionLabel: "OpenCode pull request description",
      });
    } catch (error) {
      if (signal.aborted) {
        throw new TrelloRequestAbortedError();
      }

      logDescriptionFallback(cardLog, failureStage, error, attempt);
      return undefined;
    }

    if (result.exitCode !== 0) {
      if (signal.aborted) {
        throw new TrelloRequestAbortedError();
      }

      logDescriptionFallback(
        cardLog,
        failureStage,
        new Error(
          `OpenCode exited with code ${result.exitCode}; diagnostics are available in the process execution log and session log ${sessionLogPath ?? getSessionLogPath(project.id, card.id)}`,
        ),
        attempt,
      );

      return undefined;
    }

    return result;
  };

  let snapshotBeforeGeneration;
  try {
    snapshotBeforeGeneration = await captureRepositorySnapshot(
      git,
      worktreePath,
    );
  } catch (error) {
    logDescriptionFallback(cardLog, "read-only source snapshot", error);
    return undefined;
  }

  const result = await runDescription(
    descriptionPrompt,
    "OpenCode execution",
    "initial attempt",
  );

  try {
    const snapshotAfterGeneration = await captureRepositorySnapshot(
      git,
      worktreePath,
    );
    if (
      !repositorySnapshotsEqual(
        snapshotBeforeGeneration,
        snapshotAfterGeneration,
      )
    ) {
      throw new Error(
        "Read-only pull request description generation modified source files",
      );
    }
  } catch (error) {
    logDescriptionFallback(cardLog, "read-only source verification", error);
    return undefined;
  }
  if (result === undefined) return undefined;

  try {
    const description = parsePullRequestDescription(result.output);

    cardLog.event("OpenCode pull request description generated");

    return description;
  } catch (error) {
    if (signal.aborted) {
      throw new TrelloRequestAbortedError();
    }

    cardLog.warn(
      `Pull request description generation failed on initial attempt during structured output parsing (${error instanceof PullRequestDescriptionParseError ? error.failureType : "execution-failure"})${result.processExecutionId ? `; process execution: process-executions/${result.processExecutionId}` : ""}. Requesting one corrective retry.`,
    );

    let snapshotBeforeRetry;
    try {
      snapshotBeforeRetry = await captureRepositorySnapshot(git, worktreePath);
    } catch (snapshotError) {
      if (signal.aborted) throw new TrelloRequestAbortedError();
      logDescriptionFallback(
        cardLog,
        "corrective retry read-only source snapshot",
        snapshotError,
      );
      return undefined;
    }
    const correctiveResult = await runDescription(
      [
        descriptionPrompt,
        "",
        "The previous response was invalid.",
        'Respond now with only one valid JSON object matching exactly the required schema: an object with the "summary", "changes", and "validation" fields.',
        "Do not include an introduction, explanation, Markdown, code fences, or any text before or after the JSON object.",
        "The response must start with { and end with }.",
      ].join("\n"),
      "corrective structured output execution",
      "corrective retry",
    );

    try {
      const snapshotAfterRetry = await captureRepositorySnapshot(
        git,
        worktreePath,
      );
      if (!repositorySnapshotsEqual(snapshotBeforeRetry, snapshotAfterRetry)) {
        throw new Error(
          "Read-only pull request description retry modified source files",
          { cause: error },
        );
      }
      if (correctiveResult === undefined) return undefined;
      const description = parsePullRequestDescription(correctiveResult.output);

      cardLog.event("OpenCode pull request description generated");

      return description;
    } catch (retryError) {
      if (signal.aborted) {
        throw new TrelloRequestAbortedError();
      }

      logDescriptionFallback(
        cardLog,
        "corrective structured output parsing and validation",
        retryError,
        "corrective retry",
        correctiveResult?.processExecutionId,
      );
      return undefined;
    }
  }
}

/**
 * Safely enrich a previously published, independently verified maintenance PR.
 * A description failure is presentation-only and must not undo the published head.
 */
export async function enrichMaintainedPullRequestDescription(options: {
  git: GitClient;
  github: GitHubClient;
  opencode: OpenCodeClient;
  project: ProjectConfig;
  card: TrelloCard;
  worktreePath: string;
  pullRequestUrl: string;
  commitSha: string;
  verifiedFacts: readonly string[];
  signal: AbortSignal;
}): Promise<boolean> {
  const { project, card, worktreePath } = options;
  if (options.signal.aborted) return false;
  const cardLog = logger.child({ projectId: project.id, cardId: card.id });
  const description = await generatePullRequestDescription({
    git: options.git,
    opencode: options.opencode,
    project,
    card,
    worktreePath,
    commitSha: options.commitSha,
    reviewResult: "Passed",
    remediationResult: "Verified rebase maintenance",
    signal: options.signal,
    verifiedFacts: options.verifiedFacts,
    sessionLogPath: getSessionLogPath(project.id, card.id),
    cardLog,
  });
  if (description === undefined || options.signal.aborted) return false;
  const generatedBody = renderPullRequestDescription(
    description,
    card,
    project.repository.gitIdentity.name,
  );
  const request = {
    cwd: worktreePath,
    repository: project.repository.github,
    pullRequestUrl: options.pullRequestUrl,
    project,
  };
  const currentBody = await options.github.getPullRequestDescription(request);
  const nextBody = enrichPullRequestDescription(
    currentBody,
    generatedBody,
    card,
    project.repository.gitIdentity.name,
  );
  if (nextBody === null || nextBody === currentBody || options.signal.aborted)
    return false;
  await options.github.editPullRequestDescription({
    ...request,
    body: nextBody,
  });
  cardLog.event(`Pull request description enriched: ${options.pullRequestUrl}`);
  return true;
}

export async function publishCard({
  trello,
  git,
  github,
  opencode,
  project,
  card,
  worktreePath,
  branch,
  commitSha,
  reviewResult,
  remediationResult,
  exhaustedReview,
  verifiedDescriptionFacts: verifiedDescriptionFactsOption,
  pullRequestDescription,
  sessionLogPath,
  emailNotifier,
  claimHumanReviewNotification,
  signal,
  commands,
  rebaseAlreadyCompleted = false,
  beforePushVerification,
  expectedExistingPullRequestUrl,
  qualityNeedsDraft = false,
}: PublishCardOptions): Promise<void> {
  let publicationReviewResult = reviewResult;
  let publicationReviewDisclosure = exhaustedReview ?? null;
  let publicationQualityNeedsDraft = qualityNeedsDraft;
  if (
    expectedExistingPullRequestUrl === undefined &&
    ProjectRunAuthority.isProjectLeaseScoped(project.id) &&
    !ProjectRunAuthority.current(project.id)
  )
    throw new Error(
      "Lease-scoped initial publication requires durable attempt authority",
    );
  // Production publication under attempt authority cannot opt out of the journal.
  if (ProjectRunAuthority.current(project.id)) {
    const resumed = await resumeInitialPublication({
      project,
      git,
      github,
      trello,
      ...(opencode === undefined ? {} : { opencode }),
      ...(emailNotifier === undefined ? {} : { emailNotifier }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (resumed) throw new PublicationWaitingError();
    if (expectedExistingPullRequestUrl === undefined)
      throw new Error(
        "Legacy initial publication has no durable dispatch provenance; preserve the trusted commit and reconcile explicitly",
      );
  }
  void commands;
  const cardLog = logger.child({
    projectId: project.id,
    cardId: card.id,
  });

  let pullRequest;
  let publishedCommitSha: string;
  let finalPullRequestDescription = pullRequestDescription;
  let verifiedDescriptionFacts: readonly string[] = [];

  try {
    if (signal?.aborted) {
      throw new TrelloRequestAbortedError();
    }

    const currentBranch = await git.getCurrentBranch(worktreePath);

    if (currentBranch !== branch) {
      throw new Error(
        `Publication worktree is on branch "${currentBranch}", expected "${branch}"`,
      );
    }

    const defaultBranchRef = `origin/${project.repository.defaultBranch}`;

    // Existing PR identity is still checked, but this route does not rewrite a branch
    // in any case. A remote-branch absence is never used as proof of
    // unpublished history.
    if (expectedExistingPullRequestUrl !== undefined) {
      // Never rewrite the already-published history of an existing PR merely
      // because its base advanced. Its remediation commit must fast-forward
      // from the authoritative remote task head instead.
      const existing = await github.findPullRequest({
        cwd: worktreePath,
        repository: project.repository.github,
        headBranch: branch,
        project,
      });
      if (existing?.url !== expectedExistingPullRequestUrl) {
        throw new WorkflowError(
          "Git/GitHub",
          `Existing PR ownership changed before publication: expected ${expectedExistingPullRequestUrl}`,
        );
      }
    }

    if (
      !rebaseAlreadyCompleted &&
      expectedExistingPullRequestUrl === undefined
    ) {
      cardLog.event(
        `Fetching latest ${defaultBranchRef} before publishing ${branch}...`,
      );

      if (signal?.aborted) {
        throw new TrelloRequestAbortedError();
      }

      try {
        await git.fetch(
          worktreePath,
          "origin",
          project.repository.defaultBranch,
          project,
        );
      } catch (error) {
        throw new WorkflowError(
          "Git/GitHub",
          `Failed to fetch ${defaultBranchRef} before publishing ${branch}: ${getErrorMessage(error)}. The task worktree and branch were preserved; resolve the Git failure and retry.`,
          { cause: error },
        );
      }

      if (signal?.aborted) {
        throw new TrelloRequestAbortedError();
      }

      cardLog.event(
        `Published-branch rewriting is disabled to protect published history; attempting ordinary fast-forward-safe publication without rebasing ${branch}`,
      );
    }

    publishedCommitSha = await git.getHeadSha(worktreePath);

    // Task-session callers use this hook to revalidate content-bound quality
    // evidence after the fetch/rebase preparation and before any remote write.
    const preparedReview = await beforePushVerification?.();
    if (preparedReview !== undefined) {
      publicationReviewResult = preparedReview.reviewResult;
      publicationReviewDisclosure = preparedReview.reviewDisclosure;
      if (preparedReview.qualityNeedsDraft !== undefined)
        publicationQualityNeedsDraft = preparedReview.qualityNeedsDraft;
    }

    cardLog.event(`Publication commit is ${publishedCommitSha}`);

    if (
      typeof commitSha === "string" &&
      typeof publishedCommitSha === "string" &&
      publishedCommitSha.length > 0 &&
      publishedCommitSha !== commitSha
    ) {
      try {
        writeTrustedCommitState(project, card.id, {
          version: 1,
          kind: "trusted-commit",
          projectId: project.id,
          cardId: card.id,
          taskBranch: branch,
          defaultBranch: project.repository.defaultBranch,
          commitSha: publishedCommitSha,
        });
      } catch (error) {
        throw new WorkflowError(
          "Git/GitHub",
          `Could not persist rebased trusted committed implementation: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }

    if (opencode !== undefined) {
      verifiedDescriptionFacts = verifiedDescriptionFactsOption?.() ?? [];
      finalPullRequestDescription = await generatePullRequestDescription({
        git,
        opencode,
        project,
        card,
        worktreePath,
        commitSha: publishedCommitSha,
        reviewResult: publicationReviewResult,
        remediationResult,
        verifiedFacts: verifiedDescriptionFacts,
        signal: signal ?? new AbortController().signal,
        cardLog,
        sessionLogPath:
          sessionLogPath ?? getSessionLogPath(project.id, card.id),
      });
    }

    if (signal?.aborted) {
      throw new TrelloRequestAbortedError();
    }

    const remoteCommitSha =
      typeof git.getRemoteBranchSha === "function"
        ? await git.getRemoteBranchSha(worktreePath, "origin", branch, project)
        : null;

    if (remoteCommitSha === publishedCommitSha) {
      cardLog.event(
        `Branch ${branch} is already pushed at ${publishedCommitSha}`,
      );
    } else {
      if (
        remoteCommitSha !== null &&
        typeof git.isAncestor === "function" &&
        !(await git.isAncestor(
          worktreePath,
          remoteCommitSha,
          publishedCommitSha,
        ))
      ) {
        throw new Error(
          `Refusing to publish ${branch}: rebasing produced ${publishedCommitSha}, which is not a fast-forward descendant of the remote commit ${remoteCommitSha}. A non-fast-forward update would be required; the branch was not pushed. The task worktree and branch were preserved for diagnosis and retry.`,
        );
      }

      if (signal?.aborted) {
        throw new TrelloRequestAbortedError();
      }

      cardLog.event(`Pushing branch ${branch}...`);

      await git.push(worktreePath, "origin", branch, project);

      cardLog.event("Branch pushed");
    }

    cardLog.info("Checking for existing pull request...");

    if (signal?.aborted) {
      throw new TrelloRequestAbortedError();
    }

    pullRequest = await github.findPullRequest({
      cwd: worktreePath,
      repository: project.repository.github,
      headBranch: branch,
      project,
    });

    if (
      expectedExistingPullRequestUrl !== undefined &&
      (pullRequest === null ||
        pullRequest.url !== expectedExistingPullRequestUrl)
    ) {
      throw new WorkflowError(
        "Git/GitHub",
        `Refusing to create or update a different pull request; expected ${expectedExistingPullRequestUrl}`,
      );
    }

    if (pullRequest) {
      cardLog.event(`Existing pull request found: ${pullRequest.url}`);
      if (
        publicationReviewDisclosure !== null ||
        (publicationReviewResult !== "Passed" &&
          publicationReviewResult !== reviewConcernsDismissedAsNonMaterialLabel)
      ) {
        await github.ensurePullRequestDraft({
          cwd: worktreePath,
          repository: project.repository.github,
          pullRequestUrl: pullRequest.url,
          project,
        });
        cardLog.event(
          `Unverified pull request confirmed draft: ${pullRequest.url}`,
        );
      }
      if (
        finalPullRequestDescription !== undefined &&
        typeof github.getPullRequestDescription === "function" &&
        typeof github.editPullRequestDescription === "function"
      ) {
        try {
          const publishableDescription =
            verifiedDescriptionFacts.length === 0
              ? {
                  ...finalPullRequestDescription,
                  validation: [
                    "No verified validation or test results are available.",
                  ],
                }
              : finalPullRequestDescription;
          const generatedBody = renderPullRequestDescription(
            publishableDescription,
            card,
            project.repository.gitIdentity.name,
          );
          const currentBody = await github.getPullRequestDescription({
            cwd: worktreePath,
            repository: project.repository.github,
            pullRequestUrl: pullRequest.url,
            project,
          });
          const enrichedBody = enrichPullRequestDescription(
            currentBody,
            generatedBody,
            card,
            project.repository.gitIdentity.name,
          );
          if (enrichedBody !== null && enrichedBody !== currentBody) {
            await github.editPullRequestDescription({
              cwd: worktreePath,
              repository: project.repository.github,
              pullRequestUrl: pullRequest.url,
              body: enrichedBody,
              project,
            });
            cardLog.event(
              `Pull request description enriched: ${pullRequest.url}`,
            );
          }
        } catch (error) {
          logDescriptionFallback(
            cardLog,
            "existing pull request enrichment",
            error,
          );
        }
      }
    } else {
      if (signal?.aborted) {
        throw new TrelloRequestAbortedError();
      }

      cardLog.event("Creating pull request...");

      let body = renderDeterministicPullRequestBody(
        card,
        project.repository.gitIdentity.name,
      );

      if (finalPullRequestDescription !== undefined) {
        try {
          const publishableDescription =
            verifiedDescriptionFacts.length === 0
              ? {
                  ...finalPullRequestDescription,
                  validation: [
                    "No verified validation or test results are available.",
                  ],
                }
              : finalPullRequestDescription;
          body = renderPullRequestDescription(
            publishableDescription,
            card,
            project.repository.gitIdentity.name,
          );
        } catch (error) {
          logDescriptionFallback(cardLog, "Markdown rendering", error);
        }
      }

      body = appendVerifiedWorkflowEvidence(body, verifiedDescriptionFacts);

      if (publicationReviewDisclosure !== null) {
        // This section is authored by the orchestrator and is not delegated
        // to AI-generated PR description text.
        const findings = publicationReviewDisclosure.blockingFindings
          .map((finding) => [finding.summary, finding.detail].join(": "))
          .slice(0, 20);
        const unsatisfied = publicationReviewDisclosure.requirementAssessments
          .filter((assessment) => assessment.status === "unsatisfied")
          .map((assessment) => assessment.requirementId);
        const detail = [
          ...findings,
          ...unsatisfied.map((id) => `Unsatisfied requirement: ${id}`),
        ]
          .map((entry) => `> ${entry.replace(/\s+/gu, " ").slice(0, 400)}`)
          .join("\n");
        body += [
          "",
          "## Automated review — human action required",
          "The current independent AI review reported material concerns for this source snapshot. This PR has **not** passed automated review. Please inspect the changes and findings before merging.",
          ...(publishedCommitSha !== commitSha
            ? [
                "**Post-rebase disclosure:** The published commit differs from the originally reviewed commit. Existing findings refer to the pre-rebase snapshot; the rebased content passed required local validation but has not received another AI review. Human review is mandatory.",
              ]
            : []),
          ...(detail.length > 0 ? [detail] : []),
        ].join("\n");
      }

      if (
        publicationReviewResult !== "Passed" ||
        remediationResult !== "Not required"
      )
        body += `\n\nReview: ${publicationReviewResult}\nRemediation: ${remediationResult}`;

      pullRequest = await github.createPullRequest({
        cwd: worktreePath,
        repository: project.repository.github,
        baseBranch: project.repository.defaultBranch,
        headBranch: branch,
        title: card.name,
        body,
        draft:
          publicationReviewDisclosure !== null ||
          (publicationReviewResult !== "Passed" &&
            publicationReviewResult !==
              reviewConcernsDismissedAsNonMaterialLabel) ||
          publicationQualityNeedsDraft,
        project,
      });

      cardLog.event(`Pull request created: ${pullRequest.url}`);
    }
  } catch (error) {
    if (error instanceof TrelloRequestAbortedError) {
      throw error;
    }

    if (error instanceof WorkflowError) {
      throw error;
    }

    const publicationError = toFailureError(error);

    throw new WorkflowError("Git/GitHub", publicationError.message, {
      cause: error,
    });
  }

  if (signal?.aborted) {
    throw new TrelloRequestAbortedError();
  }

  cardLog.event("Moving Trello card to Human Review...");

  // All reconstruction inputs are durable before the final external transition,
  // including before duration/draft reads that may fail or be interrupted.
  let observedDraft: boolean | undefined;
  if (ProjectRunAuthority.current(project.id)) {
    try {
      observedDraft = (
        await github.getPullRequestPublicationFields({
          cwd: worktreePath,
          repository: project.repository.github,
          pullRequestUrl: pullRequest.url,
          project,
        })
      ).isDraft;
    } catch {
      cardLog.warn(
        "PR draft observation unavailable before notification preparation",
      );
    }
  }
  if (emailNotifier && (emailNotifier.isEventEnabled?.("humanReview") ?? true))
    enqueueNotification(
      emailNotifier,
      project.id,
      "humanReview",
      publishedCommitSha,
      buildHumanReviewEmail({
        project,
        card,
        pullRequestUrl: pullRequest.url,
        commitSha: publishedCommitSha,
        reviewResult: publicationReviewResult,
        remediationResult,
        ...(observedDraft === undefined ? {} : { actualDraft: observedDraft }),
        outstandingIssues: publicationNotificationIssues(
          publicationReviewResult,
          remediationResult,
        ),
        publicationContext:
          "Verified PR publication; notification awaits Human Review destination verification.",
      }),
      {
        cardId: card.id,
        listId: project.trello.reviewListId,
        boardId: project.trello.boardId,
      },
    );

  try {
    await trello.moveCard(card.id, project.trello.reviewListId);
  } catch (error) {
    if (error instanceof TrelloRequestAbortedError) {
      throw error;
    }

    throw new PublishedCardStateError(
      `Pull request ${pullRequest.url} was published, but the Trello card could not be moved to Human Review`,
      {
        cause: error,
      },
    );
  }

  cardLog.event("Trello card moved to Human Review");

  const elapsedWorkflowTime = await getElapsedWorkflowTime(
    trello,
    project,
    card.id,
    cardLog,
  );

  let actualDraft: boolean | undefined;
  if (ProjectRunAuthority.current(project.id)) {
    try {
      actualDraft = (
        await github.getPullRequestPublicationFields({
          cwd: worktreePath,
          repository: project.repository.github,
          pullRequestUrl: pullRequest.url,
          project,
        })
      ).isDraft;
    } catch {
      cardLog.warn(
        "PR draft status could not be independently observed for notification",
      );
    }
  }

  if (
    emailNotifier !== undefined &&
    (emailNotifier.isEventEnabled?.("humanReview") ?? true) &&
    // Unowned utility compatibility only; production uses the durable outbox.
    (ProjectRunAuthority.current(project.id) !== undefined ||
      claimHumanReviewNotification === undefined ||
      claimHumanReviewNotification(publishedCommitSha))
  ) {
    await notifyHumanReview(
      emailNotifier,
      {
        project,
        card,
        pullRequestUrl: pullRequest.url,
        commitSha: publishedCommitSha,
        reviewResult: publicationReviewResult,
        remediationResult,
        ...(actualDraft === undefined ? {} : { actualDraft }),
        outstandingIssues: publicationNotificationIssues(
          publicationReviewResult,
          remediationResult,
        ),
        ...(elapsedWorkflowTime === undefined ? {} : { elapsedWorkflowTime }),
        publicationContext:
          "The pull request was published and the card was moved to Human Review by the implementation workflow.",
      },
      cardLog,
    );
  }

  const comment = [
    "Agent Orchestrator completed successfully.",
    "",
    `PR: ${pullRequest.url}`,
    `Commit: ${publishedCommitSha}`,
    `Review: ${publicationReviewResult}`,
    `Remediation: ${remediationResult}`,
    ...(elapsedWorkflowTime === undefined
      ? []
      : [`Elapsed workflow time: ${elapsedWorkflowTime}`]),
  ].join("\n");

  try {
    await trello.addComment(card.id, comment);

    cardLog.info("Trello card updated with workflow summary");
  } catch (error) {
    if (error instanceof WorkflowMutationWaitingError) throw error;
    cardLog.error(
      `Failed to add workflow summary to Trello card: ${getErrorMessage(error)}`,
    );
  }
}
import { WorkflowMutationWaitingError } from "../task-session/workflow-mutation.js";
