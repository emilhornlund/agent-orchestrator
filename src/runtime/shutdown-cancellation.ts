import { OpenCodeRunAbortedError } from "../opencode/opencode-client.js";
import {
  CommandRunAbortedError,
  CommandRunInterruptedError,
  CommandTimeoutError,
} from "../process/command-runner.js";
import {
  ProcessExecutionError,
  ProcessEvidenceError,
  ProcessGroupTerminationError,
} from "../process/process-runtime.js";
import { TrelloRequestAbortedError } from "../trello/trello-client.js";
import { AiCapacityCancelledError } from "../orchestrator/ai-execution-capacity.js";

/** Recognize typed cancellation only after shutdown was requested. Real nonzero
 * exits, timeouts, evidence failures and unknown termination remain failures. */
export function isShutdownCancellation(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  const seen = new Set<unknown>();
  const visit = (value: unknown): boolean => {
    if (!value || seen.has(value) || seen.size >= 32) return false;
    if (value instanceof ProcessExecutionError) return value.classification === "interrupted";
    if (
      value instanceof ProcessEvidenceError ||
      value instanceof ProcessGroupTerminationError ||
      value instanceof CommandTimeoutError
    )
      return false;
    if (
      value instanceof OpenCodeRunAbortedError ||
      value instanceof CommandRunAbortedError ||
      value instanceof TrelloRequestAbortedError ||
      value instanceof AiCapacityCancelledError ||
      (value instanceof CommandRunInterruptedError &&
        ["SIGINT", "SIGTERM"].includes(value.signalName)) ||
      (value instanceof DOMException && value.name === "AbortError")
    )
      return true;
    seen.add(value);
    try {
      if (value instanceof AggregateError)
        return (
          Array.isArray(value.errors) &&
          value.errors.length > 0 &&
          value.errors.every(visit) &&
          (value.cause === undefined || visit(value.cause))
        );
      return value instanceof Error && value.cause !== undefined ? visit(value.cause) : false;
    } finally {
      seen.delete(value);
    }
  };
  return visit(error);
}
