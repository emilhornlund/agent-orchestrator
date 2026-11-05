import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import type { TaskExecutionStore } from "./task-execution-store.js";
import {
  PrMaintenanceConflictError,
  PrMaintenanceStore,
} from "./pr-maintenance-store.js";
import type { PrMaintenanceOperation } from "./pr-maintenance-operation.js";

export interface PreparePublishedPrRebaseOptions {
  project: ProjectConfig;
  cardId: string;
  operationId: string;
  worktreePath: string;
  maintenanceStore: PrMaintenanceStore;
  taskExecutionStore: Pick<TaskExecutionStore, "read">;
  git: GitClient;
  github: Pick<GitHubClient, "findPullRequestState">;
  remote?: string;
}

export type PublishedPrRebasePreparationResult =
  | {
      status: "prepared" | "already-current";
      operation: PrMaintenanceOperation;
      originalHead: string;
      baseHead: string;
      resultingHead: string;
      backupRef?: string;
    }
  | {
      status: "conflicted";
      operation: PrMaintenanceOperation;
      originalHead: string;
      baseHead: string;
      conflictedPaths: string[];
      backupRef: string;
    };

/** P1 disables legacy published-rebase preparation until additive P8 maintenance. */
export async function preparePublishedPrRebase(
  _options: PreparePublishedPrRebaseOptions,
): Promise<PublishedPrRebasePreparationResult> {
  void _options;
  throw new PrMaintenanceConflictError(
    "Published PR rebase preparation is disabled by the P1 safety guardrail; preserve existing maintenance state for additive P8 recovery",
  );
}
