import fs from "node:fs";

import type { ProjectConfig } from "../config/config.js";
import {
  GitHubCredentialProvider,
  type GitHubCredential,
} from "../github/github-credential-provider.js";
import { CommandRunner } from "../process/command-runner.js";
import { redactError, redactSecrets } from "../security/redact-secrets.js";

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
      throw new Error(
        `Project "${project.id}" repository path "${repositoryPath}" exists but is not a valid Git repository`,
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
      ...(Object.keys(credential.environment).length === 0
        ? {}
        : {
            environment: credential.environment,
          }),
      ...(credential.secretValues.length === 0
        ? {}
        : { secretValues: credential.secretValues }),
    });
  } catch (error) {
    const safeError = redactError(error, credential?.secretValues);

    // Do not retain the caught error: an external command may have included a credential.
    throw new Error(
      `Failed to clone repository "${project.repository.github}" into "${repositoryPath}": ${redactSecrets(safeError.message, credential?.secretValues)}`,
      // eslint-disable-next-line preserve-caught-error
      { cause: safeError },
    );
  }

  if (cloneResult.exitCode !== 0) {
    throw new Error(
      `Failed to clone repository "${project.repository.github}" into "${repositoryPath}": gh repo clone exited with code ${cloneResult.exitCode}`,
    );
  }

  if (!(await git.isValidRepository(repositoryPath))) {
    throw new Error(
      `Repository clone completed, but project "${project.id}" destination "${repositoryPath}" is not a valid Git repository`,
    );
  }
}
