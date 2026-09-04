import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

export const refinementResultRelativePath =
  ".agent-orchestrator/refinement-result.json";

export const refinementResultContract = {
  title: {
    description: "a required non-blank string",
  },
  description: {
    description: "a required non-blank string",
  },
  type: {
    values: ["feature", "improvement", "bug"],
  },
} as const;

const refinementResultSchemaFields = {
  title: z.string().trim().min(1, "Refinement title must not be blank"),
  description: z
    .string()
    .trim()
    .min(1, "Refinement description must not be blank"),
  type: z.enum(refinementResultContract.type.values),
} satisfies {
  [field in keyof typeof refinementResultContract]: z.ZodType;
};

const refinementResultSchema = z.strictObject(refinementResultSchemaFields);

export type RefinementResult = z.infer<typeof refinementResultSchema>;

export function buildRefinementResultContractPromptLines(): string[] {
  const fields = Object.keys(refinementResultContract);
  const classifications = refinementResultContract.type.values.join(", ");

  return [
    "Validate the result object against this complete contract before writing it:",
    `- ${JSON.stringify("title")} is ${refinementResultContract.title.description}.`,
    `- ${JSON.stringify("description")} is ${refinementResultContract.description.description}.`,
    `- ${JSON.stringify("type")} is required and must be exactly one of: ${classifications}.`,
    `The object must contain exactly these fields: ${fields
      .map((field) => JSON.stringify(field))
      .join(", ")}.`,
  ];
}

export function getRefinementResultPath(worktreePath: string): string {
  return path.join(worktreePath, refinementResultRelativePath);
}

export function clearRefinementResult(worktreePath: string): void {
  const resultPath = getRefinementResultPath(worktreePath);

  fs.rmSync(resultPath, {
    force: true,
  });
}

export function readRefinementResult(worktreePath: string): RefinementResult {
  const resultPath = getRefinementResultPath(worktreePath);

  let stat: fs.Stats;

  try {
    stat = fs.lstatSync(resultPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Refinement result file not found: ${resultPath}`, {
        cause: error,
      });
    }

    throw error;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(
      `Refinement result must not be a symbolic link: ${resultPath}`,
    );
  }

  if (!stat.isFile()) {
    throw new Error(`Refinement result must be a regular file: ${resultPath}`);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid refinement result JSON: ${resultPath}`, {
      cause: error,
    });
  }

  const result = refinementResultSchema.safeParse(parsed);

  if (!result.success) {
    const messages = result.error.issues.map((issue) => {
      const location = issue.path.join(".");
      return `${location}: ${issue.message}`;
    });

    throw new Error(`Invalid refinement result:\n${messages.join("\n")}`);
  }

  return result.data;
}
