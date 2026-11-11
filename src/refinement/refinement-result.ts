import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { sanitizeControlledText } from "../security/redact-secrets.js";

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

export const refinementResultSchema = z.strictObject(
  refinementResultSchemaFields,
);

export class InvalidRefinementResultError extends Error {}

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
  const projectId = ProjectRunAuthority.currentProjectId();
  const run = projectId && ProjectRunAuthority.current(projectId)?.store.read();
  if (run) {
    if (
      path.resolve(worktreePath) !==
      path.join(run.pinned.worktreeRoot, run.cardId)
    )
      throw new Error("Refinement result worktree differs from owned attempt");
    return path.join(
      run.pinned.storageRoot,
      "refinement-results",
      run.attemptId,
      "result.json",
    );
  }
  return path.join(worktreePath, refinementResultRelativePath);
}

function assertArtifactDirectory(directory: string, create: boolean): void {
  let current = path.parse(directory).root;
  for (const component of path.relative(current, directory).split(path.sep)) {
    current = path.join(current, component);
    let stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) {
      if (!create) return;
      fs.mkdirSync(current, { mode: 0o700 });
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(
        "Unsafe refinement artifact directory; preserving unknown paths",
      );
  }
}

export function clearRefinementResult(worktreePath: string): void {
  const resultPath = getRefinementResultPath(worktreePath);

  // Preserve prior output, including interrupted/invalid output, rather than
  // deleting evidence or accepting it as a new agent result.
  assertArtifactDirectory(path.dirname(resultPath), true);
  const stat = fs.lstatSync(resultPath, { throwIfNoEntry: false });
  if (stat) {
    if (!stat.isFile())
      throw new Error(
        "Refinement output is not an owned regular result file; preserving unknown artifact",
      );
    const preserved = `${path.dirname(resultPath)}-preserved`;
    assertArtifactDirectory(preserved, true);
    fs.renameSync(resultPath, path.join(preserved, randomUUID()));
  }
}

export function readRefinementResult(worktreePath: string): RefinementResult {
  const resultPath = getRefinementResultPath(worktreePath);
  assertArtifactDirectory(path.dirname(resultPath), false);

  let stat: fs.Stats;

  try {
    stat = fs.lstatSync(resultPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new InvalidRefinementResultError(
        `Refinement result file not found: ${resultPath}`,
        {
          cause: error,
        },
      );
    }

    throw error;
  }

  if (stat.isSymbolicLink()) {
    throw new InvalidRefinementResultError(
      `Refinement result must not be a symbolic link: ${resultPath}`,
    );
  }

  if (!stat.isFile()) {
    throw new InvalidRefinementResultError(
      `Refinement result must be a regular file: ${resultPath}`,
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  } catch (error) {
    throw new InvalidRefinementResultError(
      `Invalid refinement result JSON: ${resultPath}`,
      {
        cause: error,
      },
    );
  }

  const controlled: unknown = JSON.parse(
    sanitizeControlledText(JSON.stringify(parsed)),
  );
  const result = refinementResultSchema.safeParse(controlled);

  if (!result.success) {
    const messages = result.error.issues.map((issue) => {
      const location = issue.path.join(".");
      return `${location}: ${issue.message}`;
    });

    throw new InvalidRefinementResultError(
      `Invalid refinement result:\n${messages.join("\n")}`,
    );
  }

  return result.data;
}
