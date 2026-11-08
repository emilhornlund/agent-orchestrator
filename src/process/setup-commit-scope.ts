import { createHash } from "node:crypto";

export interface SetupInventoryFile {
  path: string;
  kind: string;
  mode: number;
  sha256?: string;
  bytes?: number;
  target?: string;
}

export interface SetupInventory {
  files: SetupInventoryFile[];
  tracked: string[];
  committable: string[];
  untracked: string[];
}

export interface SetupScopeEvidence {
  version: 1;
  contextDigest: string;
  include: string[];
  exclude: { path: string; identity: string }[];
}

export interface PersistedSetupDisposition {
  version: 1;
  artifactReference: string;
  contextDigest: string;
  exclude: { path: string; identity: string }[];
}

function committablePaths(inventory: SetupInventory): Set<string> {
  return new Set(inventory.committable);
}

export function getSetupTrackedDelta(
  before: SetupInventory,
  after: SetupInventory,
  current: SetupInventory,
): {
  candidates: SetupInventoryFile[];
  contextDigest: string;
} {
  const beforeMap = new Map(before.files.map((file) => [file.path, file]));
  const afterMap = new Map(after.files.map((file) => [file.path, file]));
  const currentMap = new Map(current.files.map((file) => [file.path, file]));
  const eligible = new Set([
    ...committablePaths(before),
    ...committablePaths(after),
  ]);
  const changed = [...eligible]
    .filter(
      (filePath) =>
        JSON.stringify(beforeMap.get(filePath) ?? null) !==
        JSON.stringify(afterMap.get(filePath) ?? null),
    )
    .sort((a, b) => a.localeCompare(b));
  const context = changed.map((filePath) => ({
    path: filePath,
    before: beforeMap.has(filePath)
      ? setupFileIdentity(beforeMap.get(filePath)!)
      : null,
    after: afterMap.has(filePath)
      ? setupFileIdentity(afterMap.get(filePath)!)
      : null,
    current: currentMap.has(filePath)
      ? setupFileIdentity(currentMap.get(filePath)!)
      : null,
  }));
  return {
    candidates: changed.map(
      (filePath) => afterMap.get(filePath) ?? beforeMap.get(filePath)!,
    ),
    contextDigest: digest(context),
  };
}

export function buildSetupRelevancePrompt(
  taskName: string,
  before: SetupInventory,
  after: SetupInventory,
  current: SetupInventory,
): string {
  const { candidates, contextDigest } = getSetupTrackedDelta(
    before,
    after,
    current,
  );
  const beforeMap = new Map(before.files.map((file) => [file.path, file]));
  const afterMap = new Map(after.files.map((file) => [file.path, file]));
  const currentMap = new Map(current.files.map((file) => [file.path, file]));
  const delta = candidates.map((file) => ({
    path: file.path,
    identity: setupFileIdentity(file),
    before: beforeMap.has(file.path)
      ? setupFileIdentity(beforeMap.get(file.path)!)
      : null,
    after: afterMap.has(file.path)
      ? setupFileIdentity(afterMap.get(file.path)!)
      : null,
    current: currentMap.has(file.path)
      ? setupFileIdentity(currentMap.get(file.path)!)
      : null,
    mode: currentMap.get(file.path)?.mode ?? null,
  }));
  return [
    "Judge whether each committable tracked or unignored setup change is necessary for the stated task.",
    "This is read-only: do not edit, stage, or commit any repository file.",
    `Task: ${taskName}`,
    `Context digest: ${contextDigest}`,
    `Setup delta with before/after/current content and mode identities: ${JSON.stringify(delta)}`,
    'Return exactly one JSON object: {"version":1,"contextDigest":"sha256:...","changes":[{"path":string,"identity":string,"relevant":boolean}]}.',
    "Copy the context digest and each identity exactly, include every listed path exactly once, and mark relevant only when necessary for the task.",
    "If relevance or attribution is uncertain, do not guess; return an invalid/empty verdict so publication is blocked.",
  ].join("\n");
}

export function resolveSetupCommitScope(
  before: SetupInventory,
  after: SetupInventory,
  current: SetupInventory,
  rawVerdict: unknown,
): SetupScopeEvidence {
  const { candidates, contextDigest } = getSetupTrackedDelta(
    before,
    after,
    current,
  );
  const afterMap = new Map(after.files.map((file) => [file.path, file]));
  const currentMap = new Map(current.files.map((file) => [file.path, file]));
  if (
    typeof rawVerdict !== "object" ||
    rawVerdict === null ||
    Array.isArray(rawVerdict) ||
    (rawVerdict as Record<string, unknown>).version !== 1 ||
    (rawVerdict as Record<string, unknown>).contextDigest !== contextDigest ||
    !Array.isArray((rawVerdict as Record<string, unknown>).changes) ||
    Object.keys(rawVerdict).sort().join(",") !== "changes,contextDigest,version"
  )
    throw new Error(
      "Setup relevance verdict is malformed or context-stale; publication blocked",
    );
  const changes = (rawVerdict as { changes: unknown[] }).changes;
  if (changes.length !== candidates.length)
    throw new Error(
      "Setup relevance verdict does not cover the setup delta; publication blocked",
    );
  const verdictByPath = new Map<string, boolean>();
  for (const raw of changes) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new Error(
        "Setup relevance verdict contains an invalid entry; publication blocked",
      );
    const entry = raw as Record<string, unknown>;
    if (
      Object.keys(entry).sort().join(",") !== "identity,path,relevant" ||
      typeof entry.path !== "string" ||
      typeof entry.identity !== "string" ||
      typeof entry.relevant !== "boolean" ||
      verdictByPath.has(entry.path)
    )
      throw new Error(
        "Setup relevance verdict contains an invalid or duplicate entry; publication blocked",
      );
    const candidate = candidates.find((file) => file.path === entry.path);
    if (!candidate || entry.identity !== setupFileIdentity(candidate))
      throw new Error(
        "Setup relevance verdict references an unknown/stale path; publication blocked",
      );
    const now = currentMap.get(entry.path);
    if (
      afterMap.has(entry.path)
        ? !now ||
          setupFileIdentity(now) !==
            setupFileIdentity(afterMap.get(entry.path)!)
        : now !== undefined
    )
      throw new Error(
        `Setup change identity changed after relevance review: ${entry.path}; publication blocked`,
      );
    verdictByPath.set(entry.path, entry.relevant);
  }
  if (candidates.some((file) => !verdictByPath.has(file.path)))
    throw new Error(
      "Setup relevance verdict is incomplete; publication blocked",
    );
  const excluded = candidates
    .filter((file) => !verdictByPath.get(file.path))
    .map((file) => ({
      path: file.path,
      identity: currentMap.has(file.path)
        ? setupFileIdentity(currentMap.get(file.path)!)
        : "absent",
    }));
  return {
    version: 1,
    contextDigest,
    include: candidates
      .filter((file) => verdictByPath.get(file.path))
      .map((file) => file.path),
    exclude: excluded,
  };
}

export function setupFileIdentity(file: SetupInventoryFile): string {
  return digest(file);
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
