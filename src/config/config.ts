import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import YAML from "yaml";

const nonBlankString = z.string().refine((value) => value.trim().length > 0, {
  message: "Must not be blank",
});
const absolutePath = nonBlankString
  .refine(path.isAbsolute, {
    message: "Must be an absolute path",
  })
  .transform((value) => path.resolve(value));

export const DEFAULT_CONTEXT_ROOT = "/opt/.agent-context";

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0);

    return (
      code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f))
    );
  });
}

const pathComponent = nonBlankString.refine(
  (value) =>
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !path.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    path.win32.parse(value).root.length === 0 &&
    !hasControlCharacter(value),
  {
    message:
      "Must be a single relative path component without traversal, separators, or control characters",
  },
);

function pathsOverlap(first: string, second: string): boolean {
  const isWithin = (parent: string, candidate: string): boolean => {
    const relative = path.relative(parent, candidate);

    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative))
    );
  };

  return isWithin(first, second) || isWithin(second, first);
}

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

const githubAppSchema = z
  .strictObject({
    appId: nonBlankString.optional(),
    installationId: nonBlankString.optional(),
    privateKeyPath: absolutePath.optional(),
  })
  .superRefine((githubApp, ctx) => {
    const requiredFields = [
      ["appId", githubApp.appId],
      ["installationId", githubApp.installationId],
      ["privateKeyPath", githubApp.privateKeyPath],
    ] as const;

    for (const [field, value] of requiredFields) {
      if (value === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "Required when GitHub App settings are configured",
        });
      }
    }
  })
  .transform((githubApp) => ({
    appId: githubApp.appId!,
    installationId: githubApp.installationId!,
    privateKeyPath: githubApp.privateKeyPath!,
  }));

const repositorySchema = z.strictObject({
  path: absolutePath,
  github: nonBlankString
    .refine(
      (value) => {
        try {
          canonicalizeGitHubRepository(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: "Must identify a GitHub owner/repository" },
    )
    .transform(canonicalizeGitHubRepository),
  defaultBranch: nonBlankString,
  worktreeRoot: absolutePath,
  setupCommand: nonBlankString.optional(),
  validationCommand: nonBlankString.optional(),
  coverageCommand: nonBlankString.optional(),
  gitIdentity: gitIdentitySchema,
  githubApp: githubAppSchema.optional(),
});

const openCodeStageSchema = z.strictObject({
  model: nonBlankString.optional(),
  variant: nonBlankString.optional(),
});

const remediationSchema = z.strictObject({
  model: nonBlankString.optional(),
  variant: nonBlankString.optional(),
  maxPasses: z.number().int().nonnegative().default(1),
  validationMaxPasses: z.number().int().nonnegative().optional(),
  ciMaxPasses: z.number().int().nonnegative().safe().optional(),
});

const openCodeSchema = z.strictObject({
  refinement: openCodeStageSchema,
  planning: openCodeStageSchema.optional(),
  implementation: openCodeStageSchema,
  review: openCodeStageSchema,
  planReview: openCodeStageSchema.optional(),
  remediation: remediationSchema,
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

const emailNotificationEventsSchema = z.strictObject({
  humanReview: z.boolean().optional(),
  failed: z.boolean().optional(),
  refinementComplete: z.boolean().optional(),
  done: z.boolean().optional(),
  attentionRequired: z.boolean().optional(),
});

const emailNotificationSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    events: emailNotificationEventsSchema.optional(),
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
  id: pathComponent,
  autoMerge: z.boolean().default(false),
  maintenance: z
    .strictObject({
      enabled: z.boolean().default(false),
    })
    .optional(),
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
      pollIntervalSeconds: z.number().int().positive().default(15),
      maxConcurrentAiProjects: z.number().int().positive().safe().optional(),
      logRetentionDays: z.number().int().positive().default(30),
      contextRetentionDays: z.number().int().positive().default(14),
      contextRoot: absolutePath.default(DEFAULT_CONTEXT_ROOT),
      coordinationRoot: absolutePath.optional(),
      coordinationNamespaceId: nonBlankString.optional(),
      maxAttachmentBytes: z.number().int().positive().safe().optional(),
      maxTotalAttachmentBytes: z.number().int().positive().safe().optional(),
    }),
  })
  .superRefine((config, ctx) => {
    config.projects.forEach((project, index) => {
      if (project.autoMerge) {
        ctx.addIssue({
          code: "custom",
          path: ["projects", index, "autoMerge"],
          message:
            'Automatic pull request merging is not supported. Remove "autoMerge" or set it to false; a human must merge or close pull requests.',
        });
      }
    });

    const projectIds = config.projects.map((project) => project.id);
    const projectIdCounts = new Map<string, number>();

    for (const projectId of projectIds) {
      projectIdCounts.set(projectId, (projectIdCounts.get(projectId) ?? 0) + 1);
    }

    for (const [projectId, count] of projectIdCounts) {
      if (count > 1) {
        ctx.addIssue({
          code: "custom",
          path: ["projects"],
          message: `Duplicate project ID "${projectId}"`,
        });
      }
    }

    const githubRepositories = config.projects.map((project) =>
      canonicalizeGitHubRepository(project.repository.github),
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

    const contextRoot = config.workflow.contextRoot;
    const coordinationRoot = config.workflow.coordinationRoot;
    const coordinationNamespaceId = config.workflow.coordinationNamespaceId;
    if (
      (coordinationRoot === undefined) !==
      (coordinationNamespaceId === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["workflow"],
        message:
          "coordinationRoot and coordinationNamespaceId must be configured together",
      });
    }
    for (const [projectIndex, project] of config.projects.entries()) {
      if (
        pathsOverlap(project.repository.path, project.repository.worktreeRoot)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["projects", projectIndex, "repository"],
          message: `Repository path "${project.repository.path}" overlaps worktree root "${project.repository.worktreeRoot}" for project "${project.id}"`,
        });
      }

      const configuredPaths = [
        ["repository path", project.repository.path],
        ["worktree root", project.repository.worktreeRoot],
      ] as const;

      for (const [description, configuredPath] of configuredPaths) {
        if (pathsOverlap(contextRoot, configuredPath)) {
          ctx.addIssue({
            code: "custom",
            path: ["workflow", "contextRoot"],
            message: `Context root "${contextRoot}" overlaps ${description} "${configuredPath}" for project "${project.id}"`,
          });
        }

        if (
          coordinationRoot !== undefined &&
          pathsOverlap(coordinationRoot, configuredPath)
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["workflow", "coordinationRoot"],
            message: `Coordination root "${coordinationRoot}" overlaps ${description} "${configuredPath}" for project "${project.id}"`,
          });
        }
      }
    }
  });

export type Config = z.infer<typeof configSchema>;
export type ProjectConfig = Config["projects"][number];
export type GitHubAppConfig = NonNullable<
  ProjectConfig["repository"]["githubApp"]
>;
export type EmailNotificationConfig = NonNullable<
  NonNullable<Config["notifications"]>["email"]
>;

/** Canonical GitHub identity for supported owner/repository spellings. */
export function canonicalizeGitHubRepository(input: string): string {
  if (input !== input.trim() || /\s/.test(input)) {
    throw new Error(
      `Unsupported GitHub repository identity (whitespace is not allowed): ${input}`,
    );
  }
  let value = input;
  const spellings = [
    /^git@github\.com:/i,
    /^ssh:\/\/git@github\.com\//i,
    /^https?:\/\/(?:www\.)?github\.com\//i,
  ];
  const prefix = spellings.find((pattern) => pattern.test(value));
  if (prefix !== undefined) value = value.replace(prefix, "");
  if (value.endsWith("/")) value = value.slice(0, -1);
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(
      value,
    ) ||
    /[?#]/.test(value)
  ) {
    throw new Error(
      `Unsupported GitHub repository identity (expected owner/repository): ${input}`,
    );
  }
  while (value.toLocaleLowerCase("en-US").endsWith(".git")) {
    value = value.slice(0, -4);
  }
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(value)
  ) {
    throw new Error(`Unsupported GitHub repository identity: ${input}`);
  }
  const repository = value.slice(value.indexOf("/") + 1);
  if (repository === "." || repository === ".." || repository.endsWith(".")) {
    throw new Error(`Unsupported GitHub repository identity: ${input}`);
  }
  return value.toLocaleLowerCase("en-US");
}

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
