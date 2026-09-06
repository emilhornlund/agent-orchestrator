export interface PullRequestDescription {
  summary: string;
  changes: string[];
  validation: string[];
}

export const MAX_PULL_REQUEST_DESCRIPTION_SUMMARY_LENGTH = 1_000;
export const MAX_PULL_REQUEST_DESCRIPTION_CHANGES = 20;
export const MAX_PULL_REQUEST_DESCRIPTION_VALIDATION = 20;
export const MAX_PULL_REQUEST_DESCRIPTION_ITEM_LENGTH = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateNonBlankString(
  value: unknown,
  path: string,
  maximumLength: number,
): string | null {
  if (typeof value !== "string") {
    return `${path} must be a string`;
  }

  if (value.trim().length === 0) {
    return `${path} must not be blank`;
  }

  if (value.length > maximumLength) {
    return `${path} must not exceed ${maximumLength} characters`;
  }

  return null;
}

function validateStringArray(
  value: unknown,
  path: string,
  maximumCount: number,
): string | null {
  if (!Array.isArray(value)) {
    return `${path} must be an array of non-blank strings`;
  }

  if (value.length > maximumCount) {
    return `${path} must not contain more than ${maximumCount} items`;
  }

  for (const [index, item] of value.entries()) {
    const error = validateNonBlankString(
      item,
      `${path}[${index}]`,
      MAX_PULL_REQUEST_DESCRIPTION_ITEM_LENGTH,
    );

    if (error !== null) {
      return error;
    }
  }

  return null;
}

export function parsePullRequestDescription(
  output: string,
): PullRequestDescription {
  let parsed: unknown;

  try {
    parsed = JSON.parse(output.trim());
  } catch (error) {
    throw new Error(
      `OpenCode pull request description was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(
      "OpenCode pull request description must be exactly one JSON object",
    );
  }

  const expectedFields = new Set(["summary", "changes", "validation"]);
  const unexpectedFields = Object.keys(parsed).filter(
    (field) => !expectedFields.has(field),
  );

  if (unexpectedFields.length > 0) {
    throw new Error(
      `OpenCode pull request description contains unexpected field(s): ${unexpectedFields.join(", ")}`,
    );
  }

  for (const field of expectedFields) {
    if (!(field in parsed)) {
      throw new Error(
        `OpenCode pull request description is missing required field "${field}"`,
      );
    }
  }

  const summaryError = validateNonBlankString(
    parsed.summary,
    "summary",
    MAX_PULL_REQUEST_DESCRIPTION_SUMMARY_LENGTH,
  );

  if (summaryError !== null) {
    throw new Error(`Invalid pull request description: ${summaryError}`);
  }

  const changesError = validateStringArray(
    parsed.changes,
    "changes",
    MAX_PULL_REQUEST_DESCRIPTION_CHANGES,
  );

  if (changesError !== null) {
    throw new Error(`Invalid pull request description: ${changesError}`);
  }

  const validationError = validateStringArray(
    parsed.validation,
    "validation",
    MAX_PULL_REQUEST_DESCRIPTION_VALIDATION,
  );

  if (validationError !== null) {
    throw new Error(`Invalid pull request description: ${validationError}`);
  }

  return {
    summary: parsed.summary as string,
    changes: parsed.changes as string[],
    validation: parsed.validation as string[],
  };
}
