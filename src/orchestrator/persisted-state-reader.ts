import fs from "node:fs";

export const MAX_PERSISTED_STATE_FILE_BYTES = 1024 * 1024;

export class PersistedStateFileTooLargeError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly size: number,
  ) {
    super(
      `Persisted orchestrator state file exceeds the ${MAX_PERSISTED_STATE_FILE_BYTES}-byte limit: ${filePath} (${size} bytes)`,
    );
    this.name = "PersistedStateFileTooLargeError";
  }
}

export function readPersistedStateJson(filePath: string): unknown {
  const stat = fs.statSync(filePath, { throwIfNoEntry: false });

  if (stat !== undefined && stat.size > MAX_PERSISTED_STATE_FILE_BYTES) {
    throw new PersistedStateFileTooLargeError(filePath, stat.size);
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
