import type {
  RunTaskSessionValidationOptions,
  TaskSessionValidationResult,
} from "./run-task-session-validation.js";
import { runTaskSessionValidation } from "./run-task-session-validation.js";

/** Returns explicit skipped evidence when coverage is not configured. */
export async function runTaskSessionCoverage(
  options: RunTaskSessionValidationOptions,
): Promise<TaskSessionValidationResult> {
  const command = options.project.repository.coverageCommand;

  if (command === undefined)
    return runTaskSessionValidation({ ...options, skipWhenUnconfigured: true });

  if (command.trim().length === 0) {
    throw new Error("Task-session coverage command must not be blank");
  }

  return runTaskSessionValidation({
    ...options,
    commandOverride: command,
    commandLabel: "Task-session repository coverage",
  });
}
