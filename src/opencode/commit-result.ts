import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { GitClient } from "../git/git-client.js";

export const commitResultRelativePath =
  ".agent-orchestrator/commit-result.json";

export const MAX_COMMIT_MESSAGE_LENGTH = 4_000;

const conventionalCommitHeader =
  /^(feat|fix|refactor|docs|test|build|ci|chore)\([^)\r\n]*\S[^)\r\n]*\): \S[^\r\n]*$/;

const commitMessageSchema = z
  .string()
  .refine((value) => value.trim().length > 0, {
    message: "Commit message must not be blank",
  })
  .max(MAX_COMMIT_MESSAGE_LENGTH, "Commit message is too long")
  .refine((value) => {
    const lines = value.split(/\r?\n/);

    if (
      lines.length < 6 ||
      !conventionalCommitHeader.test(lines[0] ?? "") ||
      (lines[1] ?? "") !== "" ||
      (lines[lines.length - 2] ?? "") !== ""
    ) {
      return false;
    }

    const bulletLines = lines.slice(2, -2);
    const finalSentence = lines[lines.length - 1] ?? "";

    return (
      bulletLines.length >= 2 &&
      bulletLines.every((line) => /^- \S.*$/.test(line)) &&
      finalSentence.trim().length > 0
    );
  }, "Commit message must use the required Conventional Commit structure");

const commitResultSchema = z.strictObject({
  message: commitMessageSchema,
});

export type CommitResult = z.infer<typeof commitResultSchema>;

export interface RepositorySnapshot {
  status: string;
  unstagedDiff: string;
  stagedDiff: string;
  untrackedFiles: string;
}

function captureUntrackedFiles(
  worktreePath: string,
  filePaths: string[],
): string {
  const files = filePaths
    .map((filePath) => {
      const absolutePath = path.resolve(worktreePath, filePath);
      const relativePath = path.relative(worktreePath, absolutePath);

      if (
        relativePath.length === 0 ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
      ) {
        throw new Error(`Git returned an unsafe untracked path: ${filePath}`);
      }

      const stat = fs.lstatSync(absolutePath);

      if (stat.isFile()) {
        return {
          path: filePath,
          type: "file",
          mode: stat.mode & 0o7777,
          content: fs.readFileSync(absolutePath).toString("base64"),
        };
      }

      if (stat.isSymbolicLink()) {
        return {
          path: filePath,
          type: "symbolic-link",
          mode: stat.mode & 0o7777,
          target: fs.readlinkSync(absolutePath),
        };
      }

      return {
        path: filePath,
        type: "other",
        mode: stat.mode & 0o7777,
      };
    })
    .sort((first, second) => first.path.localeCompare(second.path));

  return JSON.stringify(files);
}

export function getCommitResultPath(worktreePath: string): string {
  return path.join(worktreePath, commitResultRelativePath);
}

export function clearCommitResult(worktreePath: string): void {
  fs.rmSync(getCommitResultPath(worktreePath), { force: true });
}

export async function captureRepositorySnapshot(
  git: GitClient,
  worktreePath: string,
): Promise<RepositorySnapshot> {
  const [status, unstagedDiff, stagedDiff, untrackedFiles] = await Promise.all([
    git.getStatus(worktreePath),
    git.getDiff(worktreePath),
    git.getDiff(worktreePath, true),
    git.getUntrackedFiles(worktreePath),
  ]);

  return {
    status,
    unstagedDiff,
    stagedDiff,
    untrackedFiles: captureUntrackedFiles(worktreePath, untrackedFiles),
  };
}

export function repositorySnapshotsEqual(
  first: RepositorySnapshot,
  second: RepositorySnapshot,
): boolean {
  return (
    first.status === second.status &&
    first.unstagedDiff === second.unstagedDiff &&
    first.stagedDiff === second.stagedDiff &&
    first.untrackedFiles === second.untrackedFiles
  );
}

export function readCommitResult(worktreePath: string): CommitResult {
  const resultPath = getCommitResultPath(worktreePath);
  let stat: fs.Stats;

  try {
    stat = fs.lstatSync(resultPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Commit result file not found: ${resultPath}`, {
        cause: error,
      });
    }

    throw error;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`Commit result must not be a symbolic link: ${resultPath}`);
  }

  if (!stat.isFile()) {
    throw new Error(`Commit result must be a regular file: ${resultPath}`);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid commit result JSON: ${resultPath}`, {
      cause: error,
    });
  }

  const result = commitResultSchema.safeParse(parsed);

  if (!result.success) {
    const messages = result.error.issues.map((issue) => {
      const location = issue.path.join(".");
      return `${location}: ${issue.message}`;
    });

    throw new Error(`Invalid commit result:\n${messages.join("\n")}`);
  }

  return result.data;
}
