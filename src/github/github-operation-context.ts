import { AsyncLocalStorage } from "node:async_hooks";

import type { ProjectConfig } from "../config/config.js";

const projectStorage = new AsyncLocalStorage<ProjectConfig>();

export function getGitHubOperationProject(): ProjectConfig | undefined {
  return projectStorage.getStore();
}

export function withGitHubOperationProject<T>(
  project: ProjectConfig,
  operation: () => Promise<T>,
): Promise<T> {
  return projectStorage.run(project, operation);
}
