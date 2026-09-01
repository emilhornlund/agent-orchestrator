import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function loadPackageMetadata(): unknown {
  try {
    return require("./package.json") as unknown;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "MODULE_NOT_FOUND"
    ) {
      throw error;
    }

    return require("../package.json") as unknown;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}

export function formatStartupEvent(metadata: unknown): string {
  if (typeof metadata !== "object" || metadata === null) {
    throw new Error(
      'Invalid package metadata: package.json must contain a non-empty string "version".',
    );
  }

  const version = (metadata as { version?: unknown }).version;

  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error(
      'Invalid package metadata: package.json must contain a non-empty string "version".',
    );
  }

  return `Agent Orchestrator v${version.trim()}`;
}

export function loadStartupEvent(
  loadMetadata: () => unknown = loadPackageMetadata,
): string {
  let metadata: unknown;

  try {
    metadata = loadMetadata();
  } catch (error) {
    throw new Error(
      `Unable to load package metadata from package.json: ${describeError(error)}`,
      { cause: error },
    );
  }

  return formatStartupEvent(metadata);
}
