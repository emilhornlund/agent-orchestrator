import fs from "node:fs";
import path from "node:path";

import type { ProjectConfig } from "../config/config.js";
import type { CardAttachmentPromptContext } from "../context/card-attachment-prompt.js";
import type { GitClient } from "../git/git-client.js";
import {
  OpenCodeClient,
  type OpenCodeRunOptions,
  type OpenCodeRunResult,
} from "../opencode/opencode-client.js";
import {
  buildTaskSessionReviewPrompt,
  type TaskSessionReviewDiff,
} from "../opencode/build-task-session-review-prompt.js";
import type { TaskSessionValidationResult } from "./run-task-session-validation.js";
import { TaskExecutionStore } from "./task-execution-store.js";
import { loadOwnedTaskExecutionRecord } from "./task-execution-ownership.js";
import { assertOwnedTaskWorktreePath } from "./run-task-session-implementation.js";
import { getTaskSessionSourceSnapshotIdentity } from "./source-snapshot.js";
import { TaskPlanStore } from "./task-plan-store.js";
import { transitionTaskExecutionRecord } from "./task-execution-transition.js";
import type { ImplementationReviewResult } from "./implementation-review-result.js";
import { parseImplementationReviewResult } from "./implementation-review-result.js";
import type { TrelloCard } from "../trello/trello-client.js";

export class TaskSessionReviewError extends Error {
  constructor(
    message: string,
    public readonly runResult?: OpenCodeRunResult,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TaskSessionReviewError";
  }
}

export interface RunTaskSessionReviewOptions {
  project: ProjectConfig;
  card: TrelloCard;
  expectedBranch: string;
  operationKey: string;
  worktreePath: string;
  taskRecordStore: TaskExecutionStore;
  planStore: TaskPlanStore;
  git: Pick<
    GitClient,
    | "getCurrentBranch"
    | "getHeadSha"
    | "getHeadTrackedFiles"
    | "getIndexEntries"
    | "getUntrackedFiles"
    | "getDiff"
  >;
  openCode: OpenCodeClient;
  validation: TaskSessionValidationResult;
  coverage: TaskSessionValidationResult | null;
  attachmentContext?: CardAttachmentPromptContext;
  runOptions: Omit<
    OpenCodeRunOptions,
    "cwd" | "prompt" | "sessionId" | "captureSessionId" | "readOnly"
  >;
}

export interface TaskSessionReviewOperationResult {
  review: ImplementationReviewResult;
  runResult: OpenCodeRunResult;
  contentIdentity: string;
}

function assertUntrackedPath(worktreePath: string, filePath: string): string {
  if (path.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) {
    throw new Error(`Git returned an absolute untracked path: ${filePath}`);
  }

  const resolvedWorktree = path.resolve(worktreePath);
  const resolvedPath = path.resolve(resolvedWorktree, filePath);
  const relative = path.relative(resolvedWorktree, resolvedPath);

  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Untracked path escapes task worktree: ${filePath}`);
  }

  return resolvedPath;
}

function readUntrackedFile(
  worktreePath: string,
  filePath: string,
): TaskSessionReviewDiff["untracked"][number] {
  const resolvedPath = assertUntrackedPath(worktreePath, filePath);
  const stats = fs.lstatSync(resolvedPath, { throwIfNoEntry: false });

  if (stats === undefined) {
    throw new Error(`Untracked file disappeared during review: ${filePath}`);
  }

  if (stats.isSymbolicLink()) {
    return {
      path: filePath,
      encoding: "symlink",
      content: fs.readlinkSync(resolvedPath),
    };
  }

  if (!stats.isFile()) {
    throw new Error(
      `Unsupported untracked file type during review: ${filePath}`,
    );
  }

  const bytes = fs.readFileSync(resolvedPath);
  const text = bytes.toString("utf8");
  const isUtf8 = Buffer.from(text, "utf8").equals(bytes);

  return {
    path: filePath,
    encoding: isUtf8 ? "utf8" : "base64",
    content: isUtf8 ? text : bytes.toString("base64"),
  };
}

async function collectCurrentDiff(
  git: RunTaskSessionReviewOptions["git"],
  worktreePath: string,
): Promise<TaskSessionReviewDiff> {
  const [staged, unstaged, untrackedPaths] = await Promise.all([
    git.getDiff(worktreePath, true),
    git.getDiff(worktreePath),
    git.getUntrackedFiles(worktreePath),
  ]);

  return {
    staged,
    unstaged,
    untracked: untrackedPaths.map((filePath) =>
      readUntrackedFile(worktreePath, filePath),
    ),
  };
}

export async function runTaskSessionReview(
  options: RunTaskSessionReviewOptions,
): Promise<TaskSessionReviewOperationResult> {
  const {
    project,
    card,
    expectedBranch,
    operationKey,
    worktreePath,
    taskRecordStore,
    planStore,
    git,
    openCode,
    validation,
    coverage,
    attachmentContext,
    runOptions,
  } = options;

  if (project.executionMode !== "task-session") {
    throw new TaskSessionReviewError(
      "Implementation review requires task-session mode",
    );
  }

  assertOwnedTaskWorktreePath(project, worktreePath);
  const record = loadOwnedTaskExecutionRecord(taskRecordStore, {
    projectId: project.id,
    cardId: card.id,
    expectedBranch,
    operationKey,
  });

  if (
    (record.phase !== "validation" && record.phase !== "review") ||
    record.sessionCreationStatus !== "bound" ||
    record.primarySessionId === undefined
  ) {
    throw new TaskSessionReviewError(
      `Implementation review requires a bound task session after validation for ${project.id}/${card.id}`,
    );
  }

  const storedPlan = planStore.read(card.id);

  if (
    storedPlan === null ||
    storedPlan.plan.projectId !== project.id ||
    storedPlan.plan.cardId !== card.id ||
    storedPlan.verification?.verdict !== "pass"
  ) {
    throw new TaskSessionReviewError(
      `Implementation review requires a passing verified plan for ${project.id}/${card.id}`,
    );
  }

  if (
    validation.status !== "passed" ||
    validation.exitCode !== 0 ||
    validation.command !== project.repository.validationCommand ||
    record.validationRepair?.status !== "passed" ||
    record.validationRepair.evidence?.contentIdentity !==
      validation.contentIdentity
  ) {
    throw new TaskSessionReviewError(
      "Implementation review requires current successful local validation evidence",
    );
  }

  const coverageCommand = project.repository.coverageCommand;

  if (coverageCommand === undefined) {
    if (coverage !== null) {
      throw new TaskSessionReviewError(
        "Coverage evidence was supplied without a configured coverage command",
      );
    }

    if (record.validationRepair.coverageEvidence !== undefined) {
      throw new TaskSessionReviewError(
        "Persisted coverage evidence conflicts with current coverage configuration",
      );
    }
  } else if (
    coverage === null ||
    coverage.status !== "passed" ||
    coverage.exitCode !== 0 ||
    coverage.command !== coverageCommand ||
    record.validationRepair.coverageEvidence?.contentIdentity !==
      coverage.contentIdentity
  ) {
    throw new TaskSessionReviewError(
      "Implementation review requires successful configured coverage evidence",
    );
  }

  const actualBranch = await git.getCurrentBranch(worktreePath);

  if (actualBranch !== expectedBranch) {
    throw new TaskSessionReviewError(
      `Implementation review branch mismatch: expected ${expectedBranch}, found ${actualBranch}`,
    );
  }

  const contentIdentity = await getTaskSessionSourceSnapshotIdentity(
    git,
    worktreePath,
  );

  if (
    contentIdentity !== validation.contentIdentity ||
    (coverage !== null && contentIdentity !== coverage.contentIdentity)
  ) {
    throw new TaskSessionReviewError(
      "Implementation review quality evidence belongs to a stale source snapshot",
    );
  }

  const diff = await collectCurrentDiff(git, worktreePath);
  const prompt = buildTaskSessionReviewPrompt({
    projectId: project.id,
    card,
    approvedPlan: storedPlan.plan,
    contentIdentity,
    diff,
    validation,
    coverage,
    ...(attachmentContext === undefined ? {} : { attachmentContext }),
  });

  if (record.phase === "validation") {
    const reviewedRecord = transitionTaskExecutionRecord(record, {
      type: "validation-passed",
      eventId: `${operationKey}:validation-passed`,
      projectId: project.id,
      cardId: card.id,
      operationKey,
      occurredAt: new Date(
        Math.max(Date.now(), Date.parse(record.updatedAt) + 1),
      ).toISOString(),
    });
    taskRecordStore.compareAndSwap(card.id, record.revision, reviewedRecord);
  }

  const runResult = await openCode.run({
    ...runOptions,
    cwd: worktreePath,
    prompt,
    readOnly: true,
  });

  if (runResult.exitCode !== 0) {
    throw new TaskSessionReviewError(
      `Independent implementation review exited with code ${runResult.exitCode}`,
      runResult,
    );
  }

  let review: ImplementationReviewResult;

  try {
    review = parseImplementationReviewResult(
      JSON.parse(runResult.output) as unknown,
      {
        projectId: project.id,
        cardId: card.id,
        requirementIds: storedPlan.plan.requirements.map(
          (requirement) => requirement.id,
        ),
        contentIdentity,
      },
    );
  } catch (error) {
    throw new TaskSessionReviewError(
      "Independent implementation review returned a malformed or stale result",
      runResult,
      { cause: error },
    );
  }

  const currentContentIdentity = await getTaskSessionSourceSnapshotIdentity(
    git,
    worktreePath,
  );

  if (currentContentIdentity !== contentIdentity) {
    throw new TaskSessionReviewError(
      "Source content changed during independent implementation review",
      runResult,
    );
  }

  return { review, runResult, contentIdentity };
}
