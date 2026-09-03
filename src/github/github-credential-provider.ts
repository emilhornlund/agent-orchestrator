import { fileURLToPath } from "node:url";

import type { ProjectConfig } from "../config/config.js";
import {
  GitHubAppApiError,
  GitHubAppAuthenticator,
  GitHubAppConfigurationError,
  GitHubAppCredentialError,
  GitHubAppNetworkError,
} from "./github-app-authenticator.js";

export type GitHubCredentialEnvironment = Record<string, string>;

export interface GitHubCredential {
  readonly mode: "ambient" | "github-app";
  readonly environment: GitHubCredentialEnvironment;
  readonly secretValues: readonly string[];
}

function describeCredentialFailure(cause: unknown): string {
  if (cause instanceof GitHubAppApiError) {
    return `GitHub App installation token exchange failed with HTTP ${cause.status ?? "unknown status"}`;
  }

  if (cause instanceof GitHubAppConfigurationError) {
    return cause.message;
  }

  if (cause instanceof GitHubAppCredentialError) {
    return cause.message;
  }

  if (cause instanceof GitHubAppNetworkError) {
    return cause.message;
  }

  return "GitHub App installation token acquisition failed";
}

export class GitHubCredentialResolutionError extends Error {
  readonly projectId: string;
  readonly repository: string;

  constructor(project: ProjectConfig, cause: unknown) {
    const safeCause = describeCredentialFailure(cause);

    super(
      `GitHub authentication failed for project "${project.id}" repository "${project.repository.github}": ${describeCredentialFailure(cause)}`,
      { cause: new Error(safeCause) },
    );
    this.name = "GitHubCredentialResolutionError";
    this.projectId = project.id;
    this.repository = project.repository.github;
  }
}

function getGitAskPassPath(): string {
  return fileURLToPath(
    new URL("../../scripts/github-git-askpass.mjs", import.meta.url),
  );
}

export interface GitHubCredentialProviderOptions {
  authenticator?: Pick<GitHubAppAuthenticator, "getInstallationToken">;
}

export class GitHubCredentialProvider {
  private readonly authenticator: Pick<
    GitHubAppAuthenticator,
    "getInstallationToken"
  >;

  constructor(options: GitHubCredentialProviderOptions = {}) {
    this.authenticator = options.authenticator ?? new GitHubAppAuthenticator();
  }

  async resolve(project?: ProjectConfig): Promise<GitHubCredential> {
    if (project?.repository.githubApp === undefined) {
      return {
        mode: "ambient",
        environment: {},
        secretValues: [process.env.GH_TOKEN, process.env.GITHUB_TOKEN].filter(
          (value): value is string => value !== undefined && value.length > 0,
        ),
      };
    }

    let token: string;

    try {
      token = await this.authenticator.getInstallationToken(
        project.repository.githubApp,
        project.repository.github,
      );
    } catch (error) {
      throw new GitHubCredentialResolutionError(project, error);
    }

    return {
      mode: "github-app",
      environment: {
        GH_TOKEN: token,
        GITHUB_TOKEN: token,
        GIT_ASKPASS: getGitAskPassPath(),
        GIT_TERMINAL_PROMPT: "0",
      },
      secretValues: [token],
    };
  }
}
