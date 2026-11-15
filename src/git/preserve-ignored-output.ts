import fs from "node:fs";
import path from "node:path";
import type { GitClient } from "./git-client.js";
import type { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import {
  readTerminalCleanup,
  writeTerminalCleanup,
} from "../task-session/terminal-cleanup-state.js";

/** Ignored is not disposable. Move it intact to attempt-owned storage before
 * removing Git resources; a durable inode plan makes each rename recoverable. */
export async function preserveIgnoredOutput(
  git: GitClient,
  worktree: string,
  authority: ProjectRunAuthority,
  signal?: AbortSignal,
): Promise<string> {
  let state = readTerminalCleanup(authority);
  if (!state) throw new Error("Cleanup preservation requires durable intent");
  const localRoot = path.join(
    path.dirname(worktree),
    ".cleanup-archives",
    authority.store.attemptId,
  );
  const legacyRoot = path.join(
    authority.store.storageRoot,
    "cleanup-archives",
    authority.store.attemptId,
  );
  // Older populated plans keep their original destination. No data relocation.
  const root = state.archiveRoot ?? (state.archive.length ? legacyRoot : localRoot);
  if (root !== localRoot && root !== legacyRoot)
    throw new Error("Cleanup archive root differs from owned attempt storage");
  if (root === worktree || root.startsWith(`${worktree}${path.sep}`))
    throw new Error("Cleanup archive must be outside the worktree");
  const paths = await git.getIgnoredCleanupPaths(worktree);
  const known = new Set(state.archive.map((entry) => entry.relativePath));
  const additions = paths
    .filter((relative) => !known.has(relative))
    .map((relativePath) => {
      safePath(worktree, relativePath);
      const stat = fs.lstatSync(path.join(worktree, relativePath), { bigint: true });
      return { relativePath, device: String(stat.dev), inode: String(stat.ino) };
    });
  state = { ...state, archiveRoot: root, archive: [...state.archive, ...additions] };
  if (state.archive.length > 4096)
    throw new Error("Cleanup archive inventory exceeds bounded limit");
  writeTerminalCleanup(authority, state);
  for (const entry of state.archive) {
    if (signal?.aborted) throw new Error("Cleanup preservation interrupted");
    authority.assertHeld();
    const source = safePath(worktree, entry.relativePath);
    const destination = safePath(root, entry.relativePath);
    const from = fs.lstatSync(source, { throwIfNoEntry: false, bigint: true });
    const to = fs.lstatSync(destination, { throwIfNoEntry: false, bigint: true });
    const matches = (stat: fs.BigIntStats | undefined) =>
      stat && String(stat.dev) === entry.device && String(stat.ino) === entry.inode;
    if (to) {
      if (from || !matches(to))
        throw new Error("Cleanup archive collision; preserving both locations");
      continue;
    }
    if (!matches(from)) throw new Error("Cleanup source identity changed; preserving worktree");
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    safePath(root, entry.relativePath);
    try {
      fs.renameSync(source, destination);
      for (const start of [path.dirname(source), path.dirname(destination)]) {
        let directory = start;
        while (true) {
          const fd = fs.openSync(directory, "r");
          try {
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
          if (directory === path.dirname(directory)) break;
          directory = path.dirname(directory);
        }
      }
    } catch (error) {
      throw new Error(
        "Ignored output archival requires recovery; inspect the durable archive plan",
        { cause: error },
      );
    }
  }
  return root;
}

function safePath(root: string, relative: string): string {
  if (
    path.isAbsolute(relative) ||
    relative
      .split(/[\\/]/u)
      .some((part) => part === ".." || part === "." || part === ".git" || !part)
  )
    throw new Error("Unsafe cleanup archive path");
  const result = path.resolve(root, relative);
  if (!result.startsWith(`${path.resolve(root)}${path.sep}`))
    throw new Error("Cleanup archive escapes its root");
  let parent = path.dirname(result);
  while (true) {
    const stat = fs.lstatSync(parent, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory()))
      throw new Error("Unsafe cleanup archive ancestor");
    if (parent === path.dirname(parent)) break;
    parent = path.dirname(parent);
  }
  return result;
}
