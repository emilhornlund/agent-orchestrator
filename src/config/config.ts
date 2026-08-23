import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import YAML from "yaml";

const githubRepositoryPattern = /^[^/]+\/[^/]+$/;
const nonBlankString = z.string().refine((value) => value.trim().length > 0, {
  message: "Must not be blank",
});
const absolutePath = nonBlankString
  .refine(path.isAbsolute, {
    message: "Must be an absolute path",
  })
  .transform((value) => path.resolve(value));

const trelloSchema = z
  .strictObject({
    boardId: nonBlankString,
    readyListId: nonBlankString,
    workingListId: nonBlankString,
    reviewListId: nonBlankString,
    failedListId: nonBlankString,
    doneListId: nonBlankString,
  })
  .superRefine((trello, ctx) => {
    const listIds = [
      trello.readyListId,
      trello.workingListId,
      trello.reviewListId,
      trello.failedListId,
      trello.doneListId,
    ];

    if (new Set(listIds).size !== listIds.length) {
      ctx.addIssue({
        code: "custom",
        message: "Trello workflow list IDs must be unique",
      });
    }
  });

const repositorySchema = z.strictObject({
  path: absolutePath,
  github: nonBlankString.regex(githubRepositoryPattern, {
    message: "Must use owner/repository format",
  }),
  defaultBranch: nonBlankString,
  worktreeRoot: absolutePath,
  validationCommand: nonBlankString.optional(),
});

const openCodeStageSchema = z.strictObject({
  model: nonBlankString,
  variant: nonBlankString,
});

const openCodeSchema = z.strictObject({
  implementation: openCodeStageSchema,
  review: openCodeStageSchema,
  remediation: openCodeStageSchema,
  commit: openCodeStageSchema,
  timeoutMinutes: z.number().positive().default(360),
});

const projectSchema = z.strictObject({
  id: nonBlankString,
  trello: trelloSchema,
  repository: repositorySchema,
  opencode: openCodeSchema,
});

const configSchema = z
  .strictObject({
    projects: z.array(projectSchema).min(1),

    workflow: z.strictObject({
      pollIntervalSeconds: z.number().int().positive(),
    }),
  })
  .superRefine((config, ctx) => {
    const projectIds = config.projects.map((project) => project.id);

    if (new Set(projectIds).size !== projectIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["projects"],
        message: "Project IDs must be unique",
      });
    }

    const githubRepositories = config.projects.map(
      (project) => project.repository.github,
    );

    if (new Set(githubRepositories).size !== githubRepositories.length) {
      ctx.addIssue({
        code: "custom",
        path: ["projects"],
        message: "GitHub repositories must be unique",
      });
    }

    const repositoryPaths = config.projects.map(
      (project) => project.repository.path,
    );

    if (new Set(repositoryPaths).size !== repositoryPaths.length) {
      ctx.addIssue({
        code: "custom",
        path: ["projects"],
        message: "Repository paths must be unique",
      });
    }

    const worktreeRoots = config.projects.map(
      (project) => project.repository.worktreeRoot,
    );

    if (new Set(worktreeRoots).size !== worktreeRoots.length) {
      ctx.addIssue({
        code: "custom",
        path: ["projects"],
        message: "Worktree roots must be unique",
      });
    }

    const trelloBoardIds = config.projects.map(
      (project) => project.trello.boardId,
    );

    if (new Set(trelloBoardIds).size !== trelloBoardIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["projects"],
        message: "Trello board IDs must be unique",
      });
    }
  });

export type Config = z.infer<typeof configSchema>;
export type ProjectConfig = Config["projects"][number];

export function parseConfig(raw: string): Config {
  let parsed: unknown;

  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const result = configSchema.safeParse(parsed);

  if (!result.success) {
    const messages = result.error.issues.map((issue) => {
      const location = issue.path.join(".");
      return `${location}: ${issue.message}`;
    });

    throw new Error(`Invalid configuration:\n${messages.join("\n")}`);
  }

  return result.data;
}

export function loadConfig(configPath = "config.yaml"): Config {
  const resolvedPath = path.resolve(configPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Config file not found: ${resolvedPath}`);
  }

  return parseConfig(fs.readFileSync(resolvedPath, "utf8"));
}
