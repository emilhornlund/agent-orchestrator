import type { ProjectConfig } from "../config/config.js";
import type { CardAttachmentPromptContext } from "../context/card-attachment-prompt.js";
import type { GitClient } from "../git/git-client.js";
import { getSessionLogPath } from "../logging/session-log.js";
import { buildRefinementPrompt } from "../opencode/build-refinement-prompt.js";
import type { OpenCodeClient } from "../opencode/opencode-client.js";
import type { TrelloCard } from "../trello/trello-client.js";
import { WorkflowError } from "../orchestrator/workflow-error.js";
import { captureSetupEffects } from "../process/run-setup.js";

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
  repositoryBaseline?: Buffer,
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
  let repositoryChanged = hasForbiddenRepositoryChanges(status);
  if (repositoryBaseline !== undefined) {
    const before = JSON.parse(repositoryBaseline.toString("utf8")) as {
      files: {
        path: string;
        kind: string;
        sha256?: string;
        bytes?: number;
        target?: string;
      }[];
      head: string;
      branch: string;
      status: string;
    };
    const after = JSON.parse(
      (await captureSetupEffects(git, worktreePath, signal)).toString("utf8"),
    ) as typeof before;
    const relevantFiles = (files: typeof before.files) =>
      files.filter((file) => file.path !== refinementResultRelativePath);
    repositoryChanged =
      before.head !== after.head ||
      before.branch !== after.branch ||
      before.status
        .split("\n")
        .filter((line) => line.slice(3) !== refinementResultRelativePath)
        .join("\n") !==
        after.status
          .split("\n")
          .filter((line) => line.slice(3) !== refinementResultRelativePath)
          .join("\n") ||
      JSON.stringify(relevantFiles(before.files)) !==
        JSON.stringify(relevantFiles(after.files));
  }

  if (repositoryChanged) {
    throw new WorkflowError(
      "OpenCode",
      `OpenCode refinement modified repository files:\n${status}`,
    );
  }

  return readRefinementResult(worktreePath);
}
