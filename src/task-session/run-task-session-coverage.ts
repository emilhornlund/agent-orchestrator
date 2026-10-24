import type {
  RunTaskSessionValidationOptions,
  TaskSessionValidationResult,
} from "./run-task-session-validation.js";
import { runTaskSessionValidation } from "./run-task-session-validation.js";

/** Returns null when coverage is not configured; configured coverage is authoritative. */
export async function runTaskSessionCoverage(
  options: RunTaskSessionValidationOptions,
): Promise<TaskSessionValidationResult | null> {
  if (options.project.executionMode !== "task-session") {
    throw new Error("Task-session coverage requires task-session mode");
  }

  const command = options.project.repository.coverageCommand;

  if (command === undefined) {
    return null;
  }

  if (command.trim().length === 0) {
    throw new Error("Task-session coverage command must not be blank");
  }

  return runTaskSessionValidation({
    ...options,
    commandOverride: command,
    commandLabel: "Task-session repository coverage",
  });
}
