import type { ProjectConfig } from "../config/config.js";
import type { CardAttachmentPromptContext } from "../context/card-attachment-prompt.js";
import type { GitClient } from "../git/git-client.js";
import { getSessionLogPath } from "../logging/session-log.js";
import { buildRefinementPrompt } from "../opencode/build-refinement-prompt.js";
import type { OpenCodeClient } from "../opencode/opencode-client.js";
import type { TrelloCard } from "../trello/trello-client.js";
import { WorkflowError } from "../orchestrator/workflow-error.js";

import {
  clearRefinementResult,
  readRefinementResult,
  refinementResultRelativePath,
  type RefinementResult,
} from "./refinement-result.js";

function hasOpenCodePermissionDenial(
  output: string,
  errorOutput: string,
): boolean {
  const combined = `${output}\n${errorOutput}`.toLowerCase();

  return (
    combined.includes("auto-rejecting") ||
    combined.includes("rejected permission") ||
    combined.includes("permission denied")
  );
}

function hasForbiddenRepositoryChanges(status: string): boolean {
  if (status.length === 0) {
    return false;
  }

  return status.split("\n").some((line) => {
    const filePath = line.slice(3);

    return filePath !== refinementResultRelativePath;
  });
}

export async function runRefinement(
  git: GitClient,
  opencode: OpenCodeClient,
  project: ProjectConfig,
  card: TrelloCard,
  worktreePath: string,
  signal: AbortSignal,
  attachmentContext?: CardAttachmentPromptContext,
): Promise<RefinementResult> {
  clearRefinementResult(worktreePath);

  const sessionLogPath = getSessionLogPath(project.id, card.id);

  const refinement = await opencode.run({
    cwd: worktreePath,
    model: project.opencode.refinement.model,
    variant: project.opencode.refinement.variant,
    timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
    prompt: buildRefinementPrompt(card, attachmentContext),
    signal,
    sessionLogPath,
    sessionLabel: "OpenCode refinement",
  });

  if (refinement.exitCode !== 0) {
    if (
      hasOpenCodePermissionDenial(refinement.output, refinement.errorOutput)
    ) {
      throw new WorkflowError(
        "OpenCode permissions",
        "OpenCode was denied permission during refinement",
      );
    }

    throw new WorkflowError(
      "OpenCode",
      `OpenCode refinement exited with code ${refinement.exitCode}`,
    );
  }

  const status = await git.getStatus(worktreePath);

  if (hasForbiddenRepositoryChanges(status)) {
    throw new WorkflowError(
      "OpenCode",
      `OpenCode refinement modified repository files:\n${status}`,
    );
  }

  return readRefinementResult(worktreePath);
}
