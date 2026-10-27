interface FileChange {
  path: string;
  metadata: string[];
  lines: string[];
}

/**
 * Compare zero-context Git patches while ignoring hunk line numbers and commit
 * metadata. This permits rebases and squash commits without treating matching
 * commit IDs as proof. Unsupported/binary patch forms fail closed.
 */
export function haveEquivalentImplementationChanges(
  originalPatch: string,
  recoveredPatch: string,
): boolean {
  const canonicalize = (patch: string): string | null => {
    const files: FileChange[] = [];
    let current: FileChange | undefined;
    let sawChange = false;
    for (const line of patch.split("\n")) {
      if (line.startsWith("diff --git ")) {
        const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
        if (match === null || match[1] === undefined || match[1] !== match[2])
          return null;
        const fileChange: FileChange = {
          path: match[1],
          metadata: [],
          lines: [],
        };
        current = fileChange;
        files.push(fileChange);
        continue;
      }
      if (
        line.startsWith("GIT binary patch") ||
        line.startsWith("Binary files ")
      )
        return null;
      if (line.startsWith("@@")) continue;
      if (
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ")
      )
        continue;
      if (line === "\\ No newline at end of file" || line.length === 0)
        continue;
      if (current === undefined) {
        if (line.trim().length > 0) return null;
        continue;
      }
      if (line.startsWith("+") || line.startsWith("-")) {
        current.lines.push(line);
        sawChange = true;
      } else if (
        line.startsWith("old mode ") ||
        line.startsWith("new mode ") ||
        line.startsWith("new file mode ") ||
        line.startsWith("deleted file mode ") ||
        line.startsWith("rename from ") ||
        line.startsWith("rename to ")
      ) {
        current.metadata.push(line);
      } else {
        return null;
      }
    }
    if (!sawChange || files.length === 0) return null;
    files.sort((left, right) => left.path.localeCompare(right.path));
    return JSON.stringify(
      files.map(({ path, metadata, lines }) => ({
        path,
        metadata: metadata.sort(),
        lines,
      })),
    );
  };

  const original = canonicalize(originalPatch);
  const recovered = canonicalize(recoveredPatch);
  return original !== null && recovered !== null && original === recovered;
}

/** Require GitHub's commit evidence to enumerate the complete base-to-head range. */
export function isCompletePullRequestCommitRange(
  pullRequestCommitShas: readonly string[],
  rangeCommitShas: readonly string[],
  pullRequestHeadSha: string,
): boolean {
  if (
    pullRequestCommitShas.length === 0 ||
    rangeCommitShas.length !== pullRequestCommitShas.length ||
    rangeCommitShas.at(-1)?.toLowerCase() !== pullRequestHeadSha.toLowerCase()
  ) {
    return false;
  }
  const expected = new Set(
    pullRequestCommitShas.map((sha) => sha.toLowerCase()),
  );
  return (
    expected.size === pullRequestCommitShas.length &&
    rangeCommitShas.every((sha) => expected.has(sha.toLowerCase())) &&
    new Set(rangeCommitShas.map((sha) => sha.toLowerCase())).size ===
      rangeCommitShas.length
  );
}
