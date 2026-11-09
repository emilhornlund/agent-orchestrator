import type { ProjectConfig } from "../config/config.js";
import type { GitClient, GitRebaseState } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import type { TrelloCard } from "../trello/trello-client.js";
import type { ImplementationReviewResult } from "../task-session/implementation-review-result.js";
import type { TaskSessionValidationResult } from "../task-session/run-task-session-validation.js";
import type { PrMaintenanceStore } from "../task-session/pr-maintenance-store.js";
import type { TaskExecutionRecord } from "../task-session/task-execution-record.js";
import type { TaskExecutionStore } from "../task-session/task-execution-store.js";
import type { TaskMutationQueue } from "../task-session/task-mutation-queue.js";
import type { CommandRunner } from "../process/command-runner.js";

export interface MaintainOutdatedPrOptions {
  project: ProjectConfig;
  card: TrelloCard;
  task: TaskExecutionRecord;
  worktreePath: string;
  git: GitClient;
  github: Pick<
    GitHubClient,
    | "findPullRequestState"
    | "getBaseBranchHeadSha"
    | "findChangesRequestedPullRequest"
    | "getPullRequestConversationComments"
  >;
  commands: CommandRunner;
  mutationQueue: TaskMutationQueue;
  taskStore: TaskExecutionStore;
  maintenanceStore: PrMaintenanceStore;
  signal: AbortSignal;
  requirementIds: readonly string[];
  eligible: boolean;
  hasRequestedChanges: boolean;
  hasUnresolvedFeedback: boolean;
  review: (input: {
    contentIdentity: string;
    preparedHead: string;
    baseHead: string;
    requirementIds: readonly string[];
    validation: TaskSessionValidationResult;
    coverage: TaskSessionValidationResult | null;
    signal: AbortSignal;
  }) => Promise<ImplementationReviewResult>;
  remediateConflict?: (input: {
    conflictedPaths: readonly string[];
    rebase: GitRebaseState;
    attempt: number;
    signal: AbortSignal;
  }) => Promise<void>;
}

/** Preserve published-PR state while automatic additive maintenance is unavailable. */
export async function maintainOutdatedPr(
  _options: MaintainOutdatedPrOptions,
): Promise<"deferred"> {
  void _options;
  return "deferred";
}

/** Legacy prepared operations are never automatically requeued. */
export function requeueInterruptedPreparedPrMaintenance(_options: {
  project: ProjectConfig;
  maintenanceStore: PrMaintenanceStore;
  mutationQueue: TaskMutationQueue;
}): boolean {
  void _options;
  return false;
}

/** Status labels do not prove unshipped rewritten commits are disposable. */
export function retireFailedUnpublishedPrMaintenance(_options: {
  project: ProjectConfig;
  maintenanceStore: PrMaintenanceStore;
  mutationQueue: TaskMutationQueue;
}): void {
  void _options;
}

/** Keep publication intents and ambiguous effects untouched for operator reconciliation. */
export async function reconcileInterruptedPrMaintenance(_options: {
  project: ProjectConfig;
  taskStore: TaskExecutionStore;
  maintenanceStore: PrMaintenanceStore;
  mutationQueue: TaskMutationQueue;
  github: Pick<GitHubClient, "findPullRequestState">;
}): Promise<void> {
  void _options;
}
