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
    backlogListId: nonBlankString,
    readyListId: nonBlankString,
    workingListId: nonBlankString,
    reviewListId: nonBlankString,
    failedListId: nonBlankString,
    doneListId: nonBlankString,
    refinementLabelId: nonBlankString,
    featureLabelId: nonBlankString,
    improvementLabelId: nonBlankString,
    bugLabelId: nonBlankString,
  })
  .superRefine((trello, ctx) => {
    const listIds = [
      trello.backlogListId,
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

    const labelIds = [
      trello.refinementLabelId,
      trello.featureLabelId,
      trello.improvementLabelId,
      trello.bugLabelId,
    ];

    if (new Set(labelIds).size !== labelIds.length) {
      ctx.addIssue({
        code: "custom",
        message: "Trello workflow label IDs must be unique",
      });
    }
  });

const gitIdentitySchema = z.strictObject({
  name: nonBlankString,
  email: nonBlankString.email(),
  signingKey: absolutePath.optional(),
});

const repositorySchema = z.strictObject({
  path: absolutePath,
  github: nonBlankString.regex(githubRepositoryPattern, {
    message: "Must use owner/repository format",
  }),
  defaultBranch: nonBlankString,
  worktreeRoot: absolutePath,
  setupCommand: nonBlankString.optional(),
  validationCommand: nonBlankString.optional(),
  gitIdentity: gitIdentitySchema,
});

const openCodeStageSchema = z.strictObject({
  model: nonBlankString,
  variant: nonBlankString,
});

const openCodeSchema = z.strictObject({
  refinement: openCodeStageSchema,
  implementation: openCodeStageSchema,
  review: openCodeStageSchema,
  remediation: openCodeStageSchema,
  commit: openCodeStageSchema,
  timeoutMinutes: z.number().positive().default(360),
});

const smtpSchema = z.strictObject({
  host: nonBlankString,
  port: z.number().int().min(1).max(65_535),
  secure: z.boolean(),
  usernameEnv: nonBlankString,
  passwordEnv: nonBlankString,
  timeoutSeconds: z.number().int().positive().default(30),
});

const emailNotificationSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    recipients: z.array(z.string().email()).min(1).optional(),
    from: z.string().email().optional(),
    smtp: smtpSchema.optional(),
  })
  .superRefine((email, ctx) => {
    if (!email.enabled) {
      return;
    }

    if (email.recipients === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["recipients"],
        message: "Required when email notifications are enabled",
      });
    }

    if (email.from === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["from"],
        message: "Required when email notifications are enabled",
      });
    }

    if (email.smtp === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["smtp"],
        message: "Required when email notifications are enabled",
      });
    }
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

    notifications: z
      .strictObject({
        email: emailNotificationSchema.optional(),
      })
      .optional(),

    workflow: z.strictObject({
      pollIntervalSeconds: z.number().int().positive(),
      logRetentionDays: z.number().int().positive().default(14),
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
export type EmailNotificationConfig = NonNullable<
  NonNullable<Config["notifications"]>["email"]
>;

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
