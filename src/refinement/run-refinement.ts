import type { ProjectConfig } from "../config/config.js";
import path from "node:path";
import { z } from "zod";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { TaskExecutionStore } from "../task-session/task-execution-store.js";
import {
  isVerifiedStoppedExecution,
  isVerifiedSuccessfulExecution,
} from "../process/process-runtime.js";
import { RefinementSetupAmbiguousError } from "./run-refinement-setup.js";
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
  getRefinementResultPath,
  readRefinementResult,
  refinementResultRelativePath,
  type RefinementResult,
  refinementResultSchema,
  InvalidRefinementResultError,
} from "./refinement-result.js";

const analysisSchema = z.strictObject({
  attempts: z.number().int().min(0).max(3),
  status: z.enum(["pending", "active", "invalid", "complete"]),
  executionId: z.string().optional(),
  command: z.string().optional(),
  result: refinementResultSchema.optional(),
});
const analysisKey = "refinement-analysis-v1";
export class RefinementAnalysisFailedError extends Error {}
class RefinementDependencyUnavailableError extends Error {}

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

async function runRefinementOnce(
  git: GitClient,
  opencode: OpenCodeClient,
  project: ProjectConfig,
  card: TrelloCard,
  worktreePath: string,
  signal: AbortSignal,
  attachmentContext?: CardAttachmentPromptContext,
  repositoryBaseline?: Buffer,
  correction = false,
  onExecutionPrepared?: (evidence: { executionId: string }) => void,
): Promise<RefinementResult> {
  clearRefinementResult(worktreePath);

  const sessionLogPath = getSessionLogPath(project.id, card.id);

  const refinement = await opencode.run({
    cwd: worktreePath,
    model: project.opencode.refinement.model,
    variant: project.opencode.refinement.variant,
    timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
    prompt:
      buildRefinementPrompt(
        card,
        attachmentContext,
        getRefinementResultPath(worktreePath),
      ) +
      (correction
        ? "\nThe previous output failed the complete JSON contract. Correct the entire result, retaining the original scope. Do not implement code."
        : ""),
    ...(onExecutionPrepared ? { onExecutionPrepared } : {}),
    refinementResultDirectory: path.dirname(
      getRefinementResultPath(worktreePath),
    ),
    signal,
    sessionLogPath,
    sessionLabel: "OpenCode refinement",
  });

  if (refinement.exitCode !== 0) {
    if (refinement.failureClassification === "dependency-outage")
      throw new RefinementDependencyUnavailableError(
        "Refinement dependency is temporarily unavailable",
      );
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

/** A correction is a new bounded analysis, never a replay of an unknown child. */
export async function runRefinement(
  git: GitClient,
  opencode: OpenCodeClient,
  project: ProjectConfig,
  card: TrelloCard,
  worktreePath: string,
  signal: AbortSignal,
  attachmentContext?: CardAttachmentPromptContext,
  repositoryBaseline?: Buffer,
  refreshAttachments?: () => Promise<CardAttachmentPromptContext | undefined>,
): Promise<RefinementResult> {
  const authority = ProjectRunAuthority.current(project.id);
  let state = authority?.read(analysisKey, analysisSchema.parse) ?? {
    attempts: 0,
    status: "pending" as const,
  };
  const save = (next: z.infer<typeof analysisSchema>) => {
    try {
      authority?.mutate(
        analysisKey,
        next,
        () => ({ value: next, result: undefined }),
        analysisSchema.parse,
      );
      state = next;
    } catch (error) {
      throw new RefinementSetupAmbiguousError(
        "Refinement analysis checkpoint could not be persisted; retaining execution and result for reconciliation",
        { cause: error },
      );
    }
  };
  if (state.status === "complete" && state.result) return state.result;
  if (state.status === "active") {
    if (!authority || !state.executionId || !state.command)
      throw new RefinementSetupAmbiguousError(
        "Refinement execution acceptance is unknown; preserving output and blocking redispatch",
      );
    const store = new TaskExecutionStore(
      authority.store.read()!.pinned.storageRoot,
      project,
      authority,
    );
    const evidence = store.readProcessExecution(card.id, state.executionId);
    const expected = {
      executionId: state.executionId,
      command: state.command,
      cwd: worktreePath,
    };
    if (isVerifiedSuccessfulExecution(evidence, expected)) {
      try {
        const result = readRefinementResult(worktreePath);
        save({ ...state, status: "complete", result });
        return result;
      } catch (error) {
        if (!(error instanceof InvalidRefinementResultError)) throw error;
        save({ ...state, status: "invalid" });
      }
    } else if (isVerifiedStoppedExecution(evidence, expected)) {
      save({ ...state, status: "invalid" });
    } else
      throw new RefinementSetupAmbiguousError(
        "Interrupted refinement child is not verified stopped; preserving output and ownership",
      );
  }
  while (state.attempts < 3) {
    if (state.attempts > 0 && refreshAttachments)
      attachmentContext = await refreshAttachments();
    const attempts = state.attempts + 1;
    save({ attempts, status: "active" });
    try {
      const result = await runRefinementOnce(
        git,
        opencode,
        project,
        card,
        worktreePath,
        signal,
        attachmentContext,
        repositoryBaseline,
        attempts > 1,
        ({ executionId }) =>
          save({
            ...state,
            executionId,
            command: `opencode run${project.opencode.refinement.model === undefined ? "" : ` --model ${project.opencode.refinement.model}`}${project.opencode.refinement.variant === undefined ? "" : ` --variant ${project.opencode.refinement.variant}`}`,
          }),
      );
      save({ ...state, status: "complete", result });
      return result;
    } catch (error) {
      if (!(error instanceof InvalidRefinementResultError)) {
        if (error instanceof RefinementSetupAmbiguousError || !authority)
          throw error;
        const evidence = state.executionId
          ? new TaskExecutionStore(
              authority.store.read()!.pinned.storageRoot,
              project,
              authority,
            ).readProcessExecution(card.id, state.executionId)
          : null;
        if (
          !state.executionId ||
          !state.command ||
          !isVerifiedStoppedExecution(evidence, {
            executionId: state.executionId,
            command: state.command,
            cwd: worktreePath,
          })
        )
          throw new RefinementSetupAmbiguousError(
            "Refinement execution did not establish a stopped child; retaining output and ownership",
            { cause: error },
          );
        save({ ...state, status: "invalid" });
        if (error instanceof RefinementDependencyUnavailableError) {
          save({ ...state, attempts: state.attempts - 1, status: "pending" });
          throw new RefinementSetupAmbiguousError(
            "Refinement dependency is unavailable; retain context and retry on a controlled recheck",
            { cause: error },
          );
        }
        if (signal.aborted)
          throw new RefinementSetupAmbiguousError(
            "Refinement interrupted; stopped execution and work are preserved",
            { cause: error },
          );
        if (state.attempts < 3) continue;
        throw new RefinementAnalysisFailedError(
          "Refinement execution failed after three verified stopped failures",
          { cause: error },
        );
      }
      save({ ...state, status: "invalid" });
      if (state.attempts === 3) throw error;
    }
  }
  throw new InvalidRefinementResultError(
    "Refinement result remains invalid after three bounded analyses",
  );
}
