import type { ProjectConfig } from "../config/config.js";
import { cleanupWorktree, CleanupWorktreeSafetyError } from "../git/cleanup-worktree.js";
import type { GitClient } from "../git/git-client.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { taskResources } from "../task-session/task-resources.js";
import {
  cleanupRetryDelayMs,
  cleanupRetryLimit,
  readTerminalCleanup,
  writeTerminalCleanup,
} from "../task-session/terminal-cleanup-state.js";

export async function cleanupTerminalResources(options: {
  project: ProjectConfig;
  git: GitClient;
  cardId: string;
  headSha: string;
  signal: AbortSignal;
  now?: Date;
  verifyHistory?: () => Promise<void>;
}): Promise<boolean> {
  const { project, git, cardId, headSha, signal } = options;
  if (signal.aborted) return false;
  const authority = ProjectRunAuthority.current(project.id);
  const resources = taskResources(project, cardId);
  const now = options.now ?? new Date();
  if (authority) {
    const prior = readTerminalCleanup(authority);
    if (prior?.status === "removed") return true;
    if (prior?.status === "pending" && prior.attempts >= cleanupRetryLimit) {
      writeTerminalCleanup(authority, {
        ...prior,
        status: "preserved",
        reason: "retry-limit",
        retryAt: null,
        updatedAt: now.toISOString(),
      });
      return false;
    }
    if (
      prior &&
      (prior.reason === "interrupted-work" ||
        prior.attempts >= cleanupRetryLimit ||
        (prior.retryAt && Date.parse(prior.retryAt) > now.getTime()))
    )
      return false;
    writeTerminalCleanup(authority, {
      version: 1,
      status: "pending",
      attempts: (prior?.attempts ?? 0) + 1,
      updatedAt: now.toISOString(),
      retryAt: new Date(now.getTime() + cleanupRetryDelayMs).toISOString(),
      reason: "inspection",
      archive: prior?.archive ?? [],
    });
  }
  try {
    await options.verifyHistory?.();
    await cleanupWorktree({
      git,
      project,
      worktreePath: resources.path,
      branch: resources.branch,
      preserveRecoveryState: true,
      preservedHeadSha: headSha,
      signal,
    });
    if (signal.aborted) return false;
    if (authority) {
      const state = readTerminalCleanup(authority)!;
      writeTerminalCleanup(authority, {
        ...state,
        status: "removed",
        reason: "removed",
        retryAt: null,
        updatedAt: now.toISOString(),
      });
    }
    return true;
  } catch (error) {
    if (authority) {
      const state = readTerminalCleanup(authority)!;
      const safety = error instanceof CleanupWorktreeSafetyError;
      const exhausted = state.attempts >= cleanupRetryLimit;
      writeTerminalCleanup(authority, {
        ...state,
        status: safety || exhausted ? "preserved" : "retryable-failure",
        reason: exhausted ? "retry-limit" : safety ? "safety" : "tool-failure",
        retryAt: exhausted ? null : new Date(now.getTime() + cleanupRetryDelayMs).toISOString(),
        updatedAt: now.toISOString(),
      });
    }
    throw error;
  }
}

export function preserveTerminalResources(projectId: string): void {
  const authority = ProjectRunAuthority.current(projectId);
  if (!authority) return;
  const prior = readTerminalCleanup(authority);
  writeTerminalCleanup(authority, {
    version: 1,
    status: "preserved",
    reason: "interrupted-work",
    attempts: prior?.attempts ?? 0,
    retryAt: null,
    updatedAt: new Date().toISOString(),
    archive: prior?.archive ?? [],
  });
}
