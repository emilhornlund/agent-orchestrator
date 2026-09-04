import { existsSync } from "node:fs";

import { getSessionLogPath } from "../logging/session-log.js";
import { OpenCodeTimeoutError } from "../opencode/opencode-client.js";

import { PublishedCardStateError } from "./published-card-state-error.js";
import {
  WorkflowError,
  type WorkflowFailureCategory,
} from "./workflow-error.js";

export type FailureCategory = WorkflowFailureCategory | "OpenCode timeout";

export interface FailureDescription {
  category: FailureCategory;
  reason: string;
}

export interface FailureContext {
  projectId: string;
  cardId?: string;
  cardIds?: string[];
  reconciliationListId?: string;
  sessionLogPath?: string;
  sessionLogPaths?: string[];
  cardFailureHandled?: boolean;
  handlingOutcome?: string;
}

interface FailureMetadata {
  context?: FailureContext;
  description?: FailureDescription;
}

const failureMetadata = new WeakMap<Error, FailureMetadata>();

function stringifyFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    const serialized = JSON.stringify(error);

    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Fall through to String for values such as circular objects.
  }

  return String(error);
}

export function toFailureError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(stringifyFailure(error), {
    cause: error,
  });
}

export function describeFailure(error: unknown): FailureDescription {
  const normalizedError = toFailureError(error);
  const metadata = failureMetadata.get(normalizedError);

  if (metadata?.description !== undefined) {
    return metadata.description;
  }

  if (normalizedError instanceof OpenCodeTimeoutError) {
    return {
      category: "OpenCode timeout",
      reason: normalizedError.message,
    };
  }

  if (normalizedError instanceof WorkflowError) {
    return {
      category: normalizedError.category,
      reason: normalizedError.message,
    };
  }

  if (
    normalizedError instanceof PublishedCardStateError &&
    normalizedError.cause !== undefined
  ) {
    return {
      category: "Workflow",
      reason: `${normalizedError.message}; Cause: ${stringifyFailure(normalizedError.cause)}`,
    };
  }

  if (normalizedError instanceof AggregateError) {
    const primaryError = normalizedError.errors[0];

    if (primaryError !== undefined) {
      return {
        category: describeFailure(primaryError).category,
        reason: normalizedError.message || stringifyFailure(normalizedError),
      };
    }
  }

  return {
    category: "Workflow",
    reason: stringifyFailure(normalizedError),
  };
}

export function getExistingSessionLogPath(
  projectId: string,
  cardId: string,
): string | undefined {
  const sessionLogPath = getSessionLogPath(projectId, cardId);

  return existsSync(sessionLogPath) ? sessionLogPath : undefined;
}

export function annotateCardFailure(
  error: Error,
  projectId: string,
  cardId: string,
): void {
  const sessionLogPath = getExistingSessionLogPath(projectId, cardId);

  annotateFailure(error, {
    projectId,
    cardId,
    ...(sessionLogPath === undefined ? {} : { sessionLogPath }),
  });
}

export function annotateFailure(
  error: Error,
  context: FailureContext,
  description?: FailureDescription,
): void {
  const existingMetadata = failureMetadata.get(error);

  failureMetadata.set(error, {
    context: {
      ...existingMetadata?.context,
      ...context,
    },
    ...(description === undefined
      ? existingMetadata?.description === undefined
        ? {}
        : { description: existingMetadata.description }
      : { description }),
  });
}

export function getFailureContext(error: unknown): FailureContext | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  return failureMetadata.get(error)?.context;
}

export function formatFailureDiagnostic(
  error: unknown,
  options: {
    sessionLogPath?: string;
    handlingOutcome?: string;
  } = {},
): string {
  const { category, reason } = describeFailure(error);
  const details = [
    `Category: ${category}`,
    `Reason: ${reason.replace(/\s+/g, " ").trim() || "No reason provided"}`,
  ];

  if (options.sessionLogPath !== undefined) {
    details.push(`Session log: ${options.sessionLogPath}`);
  }

  if (options.handlingOutcome !== undefined) {
    details.push(`Failure handling: ${options.handlingOutcome}`);
  }

  return `Task failed. ${details.join("; ")}`;
}
