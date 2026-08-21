import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import YAML from "yaml";

const githubRepositoryPattern = /^[^/]+\/[^/]+$/;

const configSchema = z
  .object({
    trello: z.object({
      boardId: z.string().min(1),
      readyListId: z.string().min(1),
      workingListId: z.string().min(1),
      reviewListId: z.string().min(1),
      doneListId: z.string().min(1),
    }),

    repository: z.object({
      path: z.string().refine(path.isAbsolute, {
        message: "Must be an absolute path",
      }),
      github: z.string().regex(githubRepositoryPattern, {
        message: "Must use owner/repository format",
      }),
      defaultBranch: z.string().min(1),
      worktreeRoot: z.string().refine(path.isAbsolute, {
        message: "Must be an absolute path",
      }),
    }),

    opencode: z.object({
      model: z.string().min(1),
      variant: z.string().min(1),
    }),

    workflow: z.object({
      pollIntervalSeconds: z.number().int().positive(),
    }),
  })
  .superRefine((config, ctx) => {
    const listIds = [
      config.trello.readyListId,
      config.trello.workingListId,
      config.trello.reviewListId,
      config.trello.doneListId,
    ];

    if (new Set(listIds).size !== listIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["trello"],
        message: "Trello workflow list IDs must be unique",
      });
    }
  });

export type Config = z.infer<typeof configSchema>;

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
