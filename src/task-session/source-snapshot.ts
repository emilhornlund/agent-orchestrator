import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { GitClient } from "../git/git-client.js";

type SnapshotGitClient = Pick<
  GitClient,
  "getHeadTrackedFiles" | "getIndexEntries" | "getUntrackedFiles"
>;
type ReadOnlyGitClient = SnapshotGitClient & Pick<GitClient, "getIgnoredFiles">;

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
      throw new Error("Git returned a malformed index entry while fingerprinting");
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
    throw new Error(`Git returned a source path outside the worktree: ${filePath}`);
  }

  let current = resolvedWorktree;
  const components = relative.split(path.sep);
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    const stats = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stats?.isSymbolicLink() && index < components.length - 1)
      throw new Error(`Symlink traversal in task source path: ${filePath}`);
    if (index < components.length - 1 && stats !== undefined && !stats.isDirectory())
      throw new Error(`Non-directory component in task source path: ${filePath}`);
  }

  return resolvedFile;
}

async function getIgnoredIdentity(worktreePath: string, files: string[]): Promise<string> {
  if (files.length > 10_000) throw new Error("Ignored source inventory exceeds the recovery limit");
  const hash = createHash("sha256");
  let totalBytes = 0;
  for (const filePath of [...files].sort()) {
    const absolute = resolveWorktreeFile(worktreePath, filePath);
    const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
    hash.update(filePath);
    if (stat === undefined) {
      hash.update("missing");
      continue;
    }
    if (stat.isSymbolicLink()) {
      hash.update("symlink");
      hash.update(fs.readlinkSync(absolute));
      continue;
    }
    if (!stat.isFile()) throw new Error(`Unsupported ignored source file type: ${filePath}`);
    if (stat.size > 16 * 1024 * 1024 || totalBytes + stat.size > 128 * 1024 * 1024)
      throw new Error("Ignored source content exceeds the recovery fingerprint limit");
    totalBytes += stat.size;
    hash.update(fs.readFileSync(absolute));
  }
  return `sha256:${hash.digest("hex")}`;
}

function addWorktreeFile(
  hash: ReturnType<typeof createHash>,
  worktreePath: string,
  filePath: string,
): number {
  const resolvedFile = resolveWorktreeFile(worktreePath, filePath);
  const stats = fs.lstatSync(resolvedFile, { throwIfNoEntry: false });

  if (stats === undefined) return 0;
  updateField(hash, "path", filePath);

  if (stats.isSymbolicLink()) {
    updateField(hash, "state", "symlink");
    updateField(hash, "target", fs.readlinkSync(resolvedFile));
    return 0;
  }

  if (!stats.isFile()) {
    throw new Error(`Unsupported source file type while fingerprinting: ${filePath}`);
  }

  updateField(hash, "state", "file");
  updateField(hash, "executable", (stats.mode & 0o111) === 0 ? "no" : "yes");
  hash.update("content", "utf8");
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(stats.size));
  hash.update(length);
  const descriptor = fs.openSync(resolvedFile, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead: number;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return stats.size;
}

/** Includes staging and ignored-file state, unlike the staging-insensitive quality identity. */
export async function getTaskSessionReadOnlyIdentity(
  git: ReadOnlyGitClient,
  worktreePath: string,
): Promise<string> {
  const [sourceIdentity, index, ignoredFiles] = await Promise.all([
    getTaskSessionSourceSnapshotIdentity(git, worktreePath),
    git.getIndexEntries(worktreePath),
    git.getIgnoredFiles(worktreePath),
  ]);
  const ignoredIdentity = await getIgnoredIdentity(worktreePath, ignoredFiles);
  return `sha256:${createHash("sha256")
    .update(sourceIdentity)
    .update(index)
    .update(ignoredIdentity)
    .digest("hex")}`;
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

  const filePaths = new Set([...headFiles, ...getIndexPaths(indexEntries), ...untrackedFiles]);
  const sortedPaths = [...filePaths].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );

  for (const filePath of sortedPaths) {
    addWorktreeFile(hash, worktreePath, filePath);
  }

  return `sha256:${hash.digest("hex")}`;
}
