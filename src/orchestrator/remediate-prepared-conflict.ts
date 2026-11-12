import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import type { OpenCodeClient } from "../opencode/opencode-client.js";
import type { CommandRunner } from "../process/command-runner.js";
import type { TrelloCard } from "../trello/trello-client.js";
import type { PreparedConflictHandoff } from "./prepared-conflict-state.js";
import { WorkflowError, type WorkflowFailureCategory } from "./workflow-error.js";

export const MAX_PREPARED_CONFLICT_REMEDIATION_ATTEMPTS = 3;

export class PreparedConflictRemediationError extends WorkflowError {
  constructor(category: WorkflowFailureCategory, message: string) {
    super(category, message);
    this.name = "PreparedConflictRemediationError";
  }
}

export interface RemediatePreparedConflictOptions {
  git: GitClient;
  github?: GitHubClient;
  opencode: OpenCodeClient;
  commands?: CommandRunner;
  project: ProjectConfig;
  card: TrelloCard;
  handoff: PreparedConflictHandoff;
  signal: AbortSignal;
  pullRequestUrl?: string;
}

/**
 * Prepared-rebase continuation is refused. Remote branch
 * absence or an OPEN-only PR lookup cannot establish that history was never
 * published (the branch may have been deleted or its PR closed/merged).
 */
export async function remediatePreparedConflict(
  _options: RemediatePreparedConflictOptions,
): Promise<void> {
  void _options;
  throw new PreparedConflictRemediationError(
    "Git/GitHub",
    "Prepared-conflict continuation is disabled to protect published history; preserve the handoff, refs, objects, intent, and worktree for operator reconciliation",
  );
}
