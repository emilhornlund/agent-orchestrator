import type { ProjectConfig } from "../config/config.js";

/** The oldest gh release whose commands and JSON fields are supported here. */
export const MINIMUM_SUPPORTED_GITHUB_CLI_VERSION = "2.40.0";

export interface GitHubCliVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: string;
}

export type RunGitHubCliCompatibilityCommand = (
  args: readonly string[],
  project?: ProjectConfig,
) => Promise<string>;

export const GITHUB_CLI_PR_STATE_JSON_FIELDS = [
  "url",
  "state",
  "mergedAt",
] as const;

export const GITHUB_CLI_PR_MAINTENANCE_JSON_FIELDS = [
  ...GITHUB_CLI_PR_STATE_JSON_FIELDS,
  "baseRefName",
  "headRefName",
  "headRepository",
  "headRepositoryOwner",
  "mergeable",
  "mergeStateStatus",
] as const;

export const GITHUB_CLI_PR_REVIEW_JSON_FIELDS = [
  "url",
  "number",
  "reviewDecision",
  "headRefOid",
] as const;

/** Union of every dynamic `gh pr list --json` field used by the service. */
export const GITHUB_CLI_REQUIRED_PR_JSON_FIELDS = [
  "url",
  "state",
  "mergedAt",
  "baseRefName",
  "headRefName",
  "headRepository",
  "headRepositoryOwner",
  "mergeable",
  "mergeStateStatus",
  "number",
  "reviewDecision",
  "headRefOid",
] as const;

export interface GitHubCliCommandCapability {
  readonly name: string;
  readonly args: readonly string[];
  readonly requiredHelpOptions: readonly string[];
}

/**
 * Keep this list aligned with every gh command and option assembled by
 * GitHubClient and ensureRepository.
 */
export const GITHUB_CLI_COMMAND_CAPABILITIES: readonly GitHubCliCommandCapability[] =
  [
    {
      name: "gh repo clone",
      args: ["repo", "clone", "--help"],
      requiredHelpOptions: [],
    },
    {
      name: "gh pr list",
      args: ["pr", "list", "--help"],
      requiredHelpOptions: [
        "--repo",
        "--head",
        "--base",
        "--state",
        "--json",
        "--jq",
        "--limit",
      ],
    },
    {
      name: "gh pr create",
      args: ["pr", "create", "--help"],
      requiredHelpOptions: ["--repo", "--base", "--head", "--title", "--body"],
    },
    {
      name: "gh pr merge",
      args: ["pr", "merge", "--help"],
      requiredHelpOptions: [
        "--repo",
        "--match-head-commit",
        "--merge",
        "--delete-branch",
      ],
    },
    {
      name: "gh api",
      args: ["api", "--help"],
      requiredHelpOptions: ["--paginate", "--slurp", "--jq"],
    },
  ];

export class GitHubCliCompatibilityError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`GitHub CLI compatibility validation failed: ${message}`, {
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = "GitHubCliCompatibilityError";
  }
}

export function parseGitHubCliVersion(
  output: string,
): GitHubCliVersion | undefined {
  const match = output.match(
    /^\s*gh version v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?(?:\s|$)/m,
  );

  if (match === null) {
    return undefined;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return undefined;
  }

  return {
    major,
    minor,
    patch,
    ...(match[4] === undefined ? {} : { prerelease: match[4] }),
  };
}

function formatGitHubCliVersion(version: GitHubCliVersion): string {
  return `${version.major}.${version.minor}.${version.patch}${version.prerelease === undefined ? "" : `-${version.prerelease}`}`;
}

function compareGitHubCliVersions(
  left: GitHubCliVersion,
  right: GitHubCliVersion,
): number {
  const pairs: readonly (readonly [number, number])[] = [
    [left.major, right.major],
    [left.minor, right.minor],
    [left.patch, right.patch],
  ];

  for (const [leftValue, rightValue] of pairs) {
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }

  if (left.prerelease === undefined && right.prerelease !== undefined) {
    return 1;
  }

  if (left.prerelease !== undefined && right.prerelease === undefined) {
    return -1;
  }

  return 0;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runCompatibilityCheck(
  run: RunGitHubCliCompatibilityCommand,
  args: readonly string[],
  description: string,
  project?: ProjectConfig,
): Promise<string> {
  try {
    return await run(args, project);
  } catch (error) {
    throw new GitHubCliCompatibilityError(
      `${description} is unavailable: ${getErrorMessage(error)}`,
      error,
    );
  }
}

export async function validateGitHubCliCompatibility(
  run: RunGitHubCliCompatibilityCommand,
  projects: readonly ProjectConfig[],
): Promise<void> {
  const versionOutput = await runCompatibilityCheck(
    run,
    ["--version"],
    "gh version output",
  );
  const version = parseGitHubCliVersion(versionOutput);

  if (version === undefined) {
    throw new GitHubCliCompatibilityError(
      `gh --version returned malformed output; expected a line like "gh version ${MINIMUM_SUPPORTED_GITHUB_CLI_VERSION}"`,
    );
  }

  const minimumVersion = parseGitHubCliVersion(
    `gh version ${MINIMUM_SUPPORTED_GITHUB_CLI_VERSION}`,
  );

  if (
    minimumVersion === undefined ||
    compareGitHubCliVersions(version, minimumVersion) < 0
  ) {
    throw new GitHubCliCompatibilityError(
      `installed gh version ${formatGitHubCliVersion(version)} is unsupported; Agent Orchestrator requires gh ${MINIMUM_SUPPORTED_GITHUB_CLI_VERSION} or newer`,
    );
  }

  for (const capability of GITHUB_CLI_COMMAND_CAPABILITIES) {
    const helpOutput = await runCompatibilityCheck(
      run,
      capability.args,
      `${capability.name} command`,
    );
    const normalizedHelp = helpOutput.toLowerCase();
    const missingOptions = capability.requiredHelpOptions.filter(
      (option) => !normalizedHelp.includes(option),
    );

    if (missingOptions.length > 0) {
      throw new GitHubCliCompatibilityError(
        `${capability.name} is missing required options: ${missingOptions.join(", ")}`,
      );
    }
  }

  const project = projects[0];

  if (project === undefined) {
    throw new GitHubCliCompatibilityError(
      "no configured project is available to validate pull request JSON fields",
    );
  }

  const jsonOutput = await runCompatibilityCheck(
    run,
    [
      "pr",
      "list",
      "--repo",
      project.repository.github,
      "--state",
      "all",
      "--limit",
      "1",
      "--json",
      GITHUB_CLI_REQUIRED_PR_JSON_FIELDS.join(","),
    ],
    `required pull request JSON fields for repository "${project.repository.github}"`,
    project,
  );

  try {
    const parsed: unknown = JSON.parse(jsonOutput);

    if (!Array.isArray(parsed)) {
      throw new Error("response was not a JSON array");
    }
  } catch (error) {
    throw new GitHubCliCompatibilityError(
      `required pull request JSON fields for repository "${project.repository.github}" returned invalid JSON`,
      error,
    );
  }
}
