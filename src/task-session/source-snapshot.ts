import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { GitClient } from "../git/git-client.js";

type SnapshotGitClient = Pick<
  GitClient,
  "getHeadTrackedFiles" | "getIndexEntries" | "getUntrackedFiles"
>;

function updateField(
  hash: ReturnType<typeof createHash>,
  label: string,
  value: Buffer | string,
): void {
  const data = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(data.length));
  hash.update(label, "utf8");
  hash.update(length);
  hash.update(data);
}

function getIndexPaths(indexEntries: string): string[] {
  const paths: string[] = [];

  for (const entry of indexEntries.split("\0")) {
    if (entry.length === 0) {
      continue;
    }

    const separatorIndex = entry.indexOf("\t");

    if (separatorIndex < 0) {
      throw new Error(
        "Git returned a malformed index entry while fingerprinting",
      );
    }

    paths.push(entry.slice(separatorIndex + 1));
  }

  return paths;
}

function resolveWorktreeFile(worktreePath: string, filePath: string): string {
  if (path.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) {
    throw new Error(`Git returned an absolute source path: ${filePath}`);
  }

  const resolvedWorktree = path.resolve(worktreePath);
  const resolvedFile = path.resolve(resolvedWorktree, filePath);
  const relative = path.relative(resolvedWorktree, resolvedFile);

  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Git returned a source path outside the worktree: ${filePath}`,
    );
  }

  return resolvedFile;
}

function addWorktreeFile(
  hash: ReturnType<typeof createHash>,
  worktreePath: string,
  filePath: string,
): void {
  const resolvedFile = resolveWorktreeFile(worktreePath, filePath);
  const stats = fs.lstatSync(resolvedFile, { throwIfNoEntry: false });

  if (stats === undefined) return;
  updateField(hash, "path", filePath);

  if (stats.isSymbolicLink()) {
    updateField(hash, "state", "symlink");
    updateField(hash, "target", fs.readlinkSync(resolvedFile));
    return;
  }

  if (!stats.isFile()) {
    throw new Error(
      `Unsupported source file type while fingerprinting: ${filePath}`,
    );
  }

  updateField(hash, "state", "file");
  updateField(hash, "executable", (stats.mode & 0o111) === 0 ? "no" : "yes");
  updateField(hash, "content", fs.readFileSync(resolvedFile));
}

export async function getTaskSessionSourceSnapshotIdentity(
  git: SnapshotGitClient,
  worktreePath: string,
): Promise<string> {
  const [indexEntries, headFiles, untrackedFiles] = await Promise.all([
    git.getIndexEntries(worktreePath),
    git.getHeadTrackedFiles(worktreePath),
    git.getUntrackedFiles(worktreePath),
  ]);
  const hash = createHash("sha256");

  // Identical working-tree contents must survive staging and commits.
  updateField(hash, "snapshot-version", "task-session-source-v2");

  const filePaths = new Set([
    ...headFiles,
    ...getIndexPaths(indexEntries),
    ...untrackedFiles,
  ]);
  const sortedPaths = [...filePaths].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );

  for (const filePath of sortedPaths) {
    addWorktreeFile(hash, worktreePath, filePath);
  }

  return `sha256:${hash.digest("hex")}`;
}
