import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import { buildPullRequestAttributionFooter } from "../github/pull-request-attribution.js";
import type { ImplementationReviewResult } from "../task-session/implementation-review-result.js";
import { enrichPullRequestDescription } from "../github/enrich-pull-request-description.js";
import { logger } from "../logging/logger.js";
import { getSessionLogPath } from "../logging/session-log.js";
import {
  notifyHumanReview,
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

import { toFailureError } from "./failure-diagnostic.js";
import { PublishedCardStateError } from "./published-card-state-error.js";
import { getElapsedWorkflowTime } from "./workflow-duration.js";
import { WorkflowError } from "./workflow-error.js";
import { writeTrustedCommitState } from "./trusted-commit-state.js";
import { writePreparedConflict } from "./prepared-conflict-state.js";
import { remediatePreparedConflict } from "./remediate-prepared-conflict.js";

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
  exhaustedReview?: ImplementationReviewResult;
  pullRequestDescription?: PullRequestDescription;
  sessionLogPath?: string;
  emailNotifier?: EmailNotifier;
  signal?: AbortSignal;
  commands?: CommandRunner;
  rebaseAlreadyCompleted?: boolean;
  beforePushVerification?: () => Promise<void>;
  expectedExistingPullRequestUrl?: string;
  verifiedDescriptionFacts?: () => readonly string[];
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
): void {
  const failureType =
    error instanceof PullRequestDescriptionParseError
      ? ` (${error.failureType})`
      : "";
  const attemptText = attempt === undefined ? "" : ` on ${attempt}`;

  cardLog.warn(
    `Pull request description generation failed${attemptText} during ${stage}${failureType}: ${getErrorMessage(error)}. Using deterministic fallback pull request body.`,
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
          `OpenCode exited with code ${result.exitCode}${result.errorOutput.trim().length > 0 ? `: ${result.errorOutput.trim()}` : ""}`,
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
      `Pull request description generation failed on initial attempt during structured output parsing${error instanceof PullRequestDescriptionParseError ? ` (${error.failureType})` : ""}: ${getErrorMessage(error)}. Requesting one corrective retry.`,
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
  signal,
  commands,
  rebaseAlreadyCompleted = false,
  beforePushVerification,
  expectedExistingPullRequestUrl,
}: PublishCardOptions): Promise<void> {
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

    if (!rebaseAlreadyCompleted) {
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

      cardLog.event(`Rebasing ${branch} onto ${defaultBranchRef}...`);

      try {
        await git.rebase(
          worktreePath,
          defaultBranchRef,
          project.repository.gitIdentity,
        );
      } catch (error) {
        let rebaseState;
        let conflictedPaths: string[];

        try {
          rebaseState = await git.getRebaseState(worktreePath);
          conflictedPaths = await git.getConflictedPaths(worktreePath);
        } catch (inspectionError) {
          throw new WorkflowError(
            "Git/GitHub",
            `Failed to rebase ${branch} onto ${defaultBranchRef}: ${getErrorMessage(error)}. Git could not confirm an active rebase conflict (${getErrorMessage(inspectionError)}); the task worktree and branch were preserved for diagnosis and retry.`,
            { cause: error },
          );
        }

        if (rebaseState === null || conflictedPaths.length === 0) {
          throw new WorkflowError(
            "Git/GitHub",
            `Failed to rebase ${branch} onto ${defaultBranchRef}: ${getErrorMessage(error)}. Git did not report an active rebase with conflicted paths; the task worktree and branch were preserved for diagnosis and retry.`,
            { cause: error },
          );
        }

        let handoff;

        try {
          handoff = writePreparedConflict(
            project,
            card.id,
            conflictedPaths,
            rebaseState,
            {
              origin: "initial-publication",
              trustedTaskCommitSha: commitSha,
              rebaseTargetSha: rebaseState.onto,
            },
          );
        } catch (handoffError) {
          throw new WorkflowError(
            "Git/GitHub",
            `Failed to preserve the publication rebase conflict for ${branch}: ${getErrorMessage(handoffError)}. The task worktree and branch were preserved for diagnosis and retry.`,
            { cause: handoffError },
          );
        }

        cardLog.event(
          `Preserved publication rebase conflict for automated conflict remediation: ${conflictedPaths.join(", ")}`,
        );

        if (opencode === undefined) {
          throw new WorkflowError(
            "OpenCode",
            `Publication rebase conflict for ${branch} was preserved for automated conflict remediation, but no OpenCode client is configured.`,
            { cause: error },
          );
        }

        await remediatePreparedConflict({
          git,
          github,
          opencode,
          ...(commands === undefined ? {} : { commands }),
          project,
          card,
          handoff,
          signal: signal ?? new AbortController().signal,
        });
      }
    }

    publishedCommitSha = await git.getHeadSha(worktreePath);

    // Task-session callers use this hook to revalidate content-bound quality
    // evidence after the fetch/rebase preparation and before any remote write.
    await beforePushVerification?.();

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
        reviewResult,
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

      if (exhaustedReview !== undefined) {
        // This section is authored by the orchestrator and is not delegated
        // to AI-generated PR description text.
        const findings = exhaustedReview.blockingFindings
          .map((finding) => [finding.summary, finding.detail].join(": "))
          .slice(0, 20);
        const unsatisfied = exhaustedReview.requirementAssessments
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
          "The independent AI review still reported blocking findings after the configured remediation limit. This PR has **not** passed automated review. Please inspect the changes and findings before merging.",
          ...(detail.length > 0 ? [detail] : []),
        ].join("\n");
      }

      pullRequest = await github.createPullRequest({
        cwd: worktreePath,
        repository: project.repository.github,
        baseBranch: project.repository.defaultBranch,
        headBranch: branch,
        title: card.name,
        body,
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

  await notifyHumanReview(
    emailNotifier,
    {
      project,
      card,
      pullRequestUrl: pullRequest.url,
      commitSha: publishedCommitSha,
      reviewResult,
      remediationResult,
      ...(elapsedWorkflowTime === undefined ? {} : { elapsedWorkflowTime }),
      publicationContext:
        "The pull request was published and the card was moved to Human Review by the implementation workflow.",
    },
    cardLog,
  );

  const comment = [
    "Agent Orchestrator completed successfully.",
    "",
    `PR: ${pullRequest.url}`,
    `Commit: ${publishedCommitSha}`,
    `Review: ${reviewResult}`,
    `Remediation: ${remediationResult}`,
    ...(elapsedWorkflowTime === undefined
      ? []
      : [`Elapsed workflow time: ${elapsedWorkflowTime}`]),
  ].join("\n");

  try {
    await trello.addComment(card.id, comment);

    cardLog.info("Trello card updated with workflow summary");
  } catch (error) {
    cardLog.error(
      `Failed to add workflow summary to Trello card: ${getErrorMessage(error)}`,
    );
  }
}
