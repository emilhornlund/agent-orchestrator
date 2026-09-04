import type { CommandRunner, CommandRunResult } from "./command-runner.js";
import { CommandRunAbortedError } from "./command-runner.js";
import { toFailureError } from "../orchestrator/failure-diagnostic.js";
import { WorkflowError } from "../orchestrator/workflow-error.js";

export async function runRepositorySetup(
  commands: CommandRunner,
  options: {
    cwd: string;
    command: string;
    timeoutMilliseconds: number;
    signal?: AbortSignal;
    sessionLogPath: string;
    sessionLabel: string;
  },
): Promise<CommandRunResult> {
  try {
    return await commands.run({
      cwd: options.cwd,
      command: options.command,
      timeoutMilliseconds: options.timeoutMilliseconds,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      sessionLogPath: options.sessionLogPath,
      sessionLabel: options.sessionLabel,
    });
  } catch (error) {
    if (error instanceof CommandRunAbortedError) {
      throw error;
    }

    const setupError = toFailureError(error);

    throw new WorkflowError("Setup", setupError.message, { cause: error });
  }
}
