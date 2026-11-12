import fs from "node:fs";

import type { ProjectConfig } from "../config/config.js";
import {
  GitHubCredentialProvider,
  type GitHubCredential,
} from "../github/github-credential-provider.js";
import { CommandRunner } from "../process/command-runner.js";
import { redactError, redactSecrets } from "../security/redact-secrets.js";
import { ProjectResourceError } from "../startup/project-resource-error.js";

import { GitClient } from "./git-client.js";

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function ensureRepository(
  git: GitClient,
  commands: CommandRunner,
  project: ProjectConfig,
  credentials: GitHubCredentialProvider = new GitHubCredentialProvider(),
): Promise<void> {
  const repositoryPath = project.repository.path;

  if (fs.existsSync(repositoryPath)) {
    if (!(await git.isValidRepository(repositoryPath))) {
      throw new ProjectResourceError(
        "invalid",
        `Project "${project.id}" repository path "${repositoryPath}" exists but is not a valid Git repository`,
      );
    }

    try {
      await git.assertOriginMatches(repositoryPath, project.repository.github);
    } catch (error) {
      throw new ProjectResourceError(
        "invalid",
        `Project "${project.id}" checkout does not match configured GitHub repository "${project.repository.github}": ${error instanceof Error ? error.message : "origin could not be verified"}`,
        error,
      );
    }

    return;
  }

  const cloneCommand = [
    "gh",
    "repo",
    "clone",
    shellQuote(project.repository.github),
    shellQuote(repositoryPath),
  ].join(" ");

  let cloneResult;
  let credential: GitHubCredential | undefined;

  try {
    credential = await credentials.resolve(project);

    cloneResult = await commands.run({
      cwd: process.cwd(),
      command:
        credential.mode === "github-app"
          ? `${cloneCommand} -- -c credential.helper=`
          : cloneCommand,
      processFamily: "github",
      ...(Object.keys(credential.environment).length === 0
        ? {}
        : {
            environment: credential.environment,
          }),
      ...(credential.secretValues.length === 0 ? {} : { secretValues: credential.secretValues }),
    });
  } catch (error) {
    const safeError = redactError(error, credential?.secretValues);
    const safeMessage = redactSecrets(safeError.message, credential?.secretValues);
    const disposition = isKnownTransientGitHubFailure(safeMessage) ? "unavailable" : "invalid";

    // Do not retain the caught error: an external command may have included a credential.
    throw new ProjectResourceError(
      disposition,
      `Failed to clone repository "${project.repository.github}" into "${repositoryPath}": ${disposition === "unavailable" ? "GitHub/network resource is temporarily unavailable; retrying" : "GitHub rejected the repository or credentials; verify project configuration and access"}`,
      safeError,
    );
  }

  if (cloneResult.exitCode !== 0) {
    const detail = redactSecrets(cloneResult.errorOutput ?? "", credential?.secretValues);
    const disposition = isKnownTransientGitHubFailure(detail) ? "unavailable" : "invalid";
    throw new ProjectResourceError(
      disposition,
      `Failed to clone repository "${project.repository.github}" into "${repositoryPath}": ${disposition === "unavailable" ? "GitHub/network resource is temporarily unavailable; retrying" : "GitHub rejected the repository or credentials; verify project configuration and access"}`,
    );
  }

  if (!(await git.isValidRepository(repositoryPath))) {
    throw new ProjectResourceError(
      "invalid",
      `Repository clone completed, but project "${project.id}" destination "${repositoryPath}" is not a valid Git repository`,
    );
  }
}

function isKnownTransientGitHubFailure(message: string): boolean {
  return /(?:timed?\s*out|timeout|temporarily unavailable|connection reset|connection refused|could not resolve|name or service not known|network is unreachable|TLS handshake|HTTP 5\d\d|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout)/iu.test(
    message,
  );
}
