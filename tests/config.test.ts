import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/config.js";

const validConfig = `
projects:
  - id: "project-one"

    trello:
      boardId: "board-one"
      backlogListId: "backlog"
      readyListId: "ready"
      workingListId: "working"
      reviewListId: "review"
      failedListId: "failed"
      doneListId: "done"
      refinementLabelId: "refinement"
      featureLabelId: "feature"
      improvementLabelId: "improvement"
      bugLabelId: "bug"

    repository:
      path: "/tmp/repository"
      github: "owner/repository"
      defaultBranch: "main"
      worktreeRoot: "/tmp/worktrees"
      validationCommand: "yarn validate"
      gitIdentity:
        name: "Agent Orchestrator"
        email: "agent-orchestrator@users.noreply.github.com"

    opencode:
      timeoutMinutes: 360
      refinement:
        model: "openai/refinement-model"
        variant: "xhigh"
      implementation:
        model: "openai/implementation-model"
        variant: "xhigh"
      review:
        model: "openai/review-model"
        variant: "high"
      remediation:
        model: "openai/remediation-model"
        variant: "xhigh"
      commit:
        model: "openai/commit-model"
        variant: "low"

workflow:
  pollIntervalSeconds: 15
`;

function appendProject(raw: string, id: string, suffix: string): string {
  return raw.replace(
    "\nworkflow:",
    `
  - id: "${id}"

    trello:
      boardId: "board-${suffix}"
      backlogListId: "backlog-${suffix}"
      readyListId: "ready-${suffix}"
      workingListId: "working-${suffix}"
      reviewListId: "review-${suffix}"
      failedListId: "failed-${suffix}"
      doneListId: "done-${suffix}"
      refinementLabelId: "refinement-${suffix}"
      featureLabelId: "feature-${suffix}"
      improvementLabelId: "improvement-${suffix}"
      bugLabelId: "bug-${suffix}"

    repository:
      path: "/tmp/repository-${suffix}"
      github: "owner/repository-${suffix}"
      defaultBranch: "main"
      worktreeRoot: "/tmp/worktrees-${suffix}"
      gitIdentity:
        name: "Agent Orchestrator"
        email: "agent-orchestrator@users.noreply.github.com"

    opencode:
      timeoutMinutes: 360
      refinement:
        model: "openai/refinement-model"
        variant: "xhigh"
      implementation:
        model: "openai/implementation-model"
        variant: "xhigh"
      review:
        model: "openai/review-model"
        variant: "high"
      remediation:
        model: "openai/remediation-model"
        variant: "xhigh"
      commit:
        model: "openai/commit-model"
        variant: "low"

workflow:`,
  );
}

function configWithProjectIds(projectIds: readonly string[]): string {
  const firstProjectId = projectIds[0];

  if (firstProjectId === undefined) {
    throw new Error("At least one project ID is required");
  }

  return projectIds
    .slice(1)
    .reduce(
      (raw, projectId, index) => appendProject(raw, projectId, `${index + 2}`),
      validConfig.replace('id: "project-one"', `id: "${firstProjectId}"`),
    );
}

const githubAppValues = {
  appId: '"123456"',
  installationId: '"987654"',
  privateKeyPath: '"/tmp/github-app-key/../private-key.pem"',
} as const;

type GitHubAppField = keyof typeof githubAppValues;

function configWithGithubApp(fields: readonly GitHubAppField[]): string {
  const settings = fields
    .map((field) => `        ${field}: ${githubAppValues[field]}`)
    .join("\n");
  const githubApp =
    settings.length === 0
      ? "      githubApp: {}"
      : `      githubApp:\n${settings}`;

  return validConfig.replace(
    '      github: "owner/repository"',
    `      github: "owner/repository"\n${githubApp}`,
  );
}

function configWithGithubAppValues(
  values: Partial<Record<GitHubAppField, string>>,
): string {
  const fields = Object.keys(githubAppValues) as GitHubAppField[];
  const settings = fields
    .map(
      (field) => `        ${field}: ${values[field] ?? githubAppValues[field]}`,
    )
    .join("\n");

  return validConfig.replace(
    '      github: "owner/repository"',
    `      github: "owner/repository"\n      githubApp:\n${settings}`,
  );
}

describe("parseConfig", () => {
  it("accepts valid configuration", () => {
    const config = parseConfig(validConfig);

    expect(config.projects).toHaveLength(1);

    const project = config.projects[0];

    expect(project).toBeDefined();
    expect(project!.id).toBe("project-one");
    expect(project!.autoMerge).toBe(false);
    expect(project!.trello).toEqual({
      boardId: "board-one",
      backlogListId: "backlog",
      readyListId: "ready",
      workingListId: "working",
      reviewListId: "review",
      failedListId: "failed",
      doneListId: "done",
      refinementLabelId: "refinement",
      featureLabelId: "feature",
      improvementLabelId: "improvement",
      bugLabelId: "bug",
    });
    expect(project!.repository.github).toBe("owner/repository");
    expect(project!.repository.githubApp).toBeUndefined();
    expect(project!.repository.setupCommand).toBeUndefined();
    expect(project!.repository.validationCommand).toBe("yarn validate");
    expect(project!.opencode.refinement).toEqual({
      model: "openai/refinement-model",
      variant: "xhigh",
    });
    expect(project!.opencode.implementation).toEqual({
      model: "openai/implementation-model",
      variant: "xhigh",
    });
    expect(project!.opencode.review).toEqual({
      model: "openai/review-model",
      variant: "high",
    });
    expect(project!.opencode.remediation).toEqual({
      model: "openai/remediation-model",
      variant: "xhigh",
      maxPasses: 1,
    });
    expect(project!.opencode.commit).toEqual({
      model: "openai/commit-model",
      variant: "low",
    });
    expect(project!.opencode.timeoutMinutes).toBe(360);
    expect(config.workflow.pollIntervalSeconds).toBe(15);
    expect(config.workflow.logRetentionDays).toBe(14);
    expect(config.workflow.contextRetentionDays).toBe(14);
    expect(config.workflow.contextRoot).toBe("/opt/.agent-context");
    expect(config.notifications).toBeUndefined();
  });

  it("accepts and normalizes a complete GitHub App configuration", () => {
    const config = parseConfig(
      configWithGithubApp(["appId", "installationId", "privateKeyPath"]),
    );

    expect(config.projects[0]?.repository.githubApp).toEqual({
      appId: "123456",
      installationId: "987654",
      privateKeyPath: "/tmp/private-key.pem",
    });
  });

  it.each<[string, readonly GitHubAppField[], readonly GitHubAppField[]]>([
    ["empty", [], ["appId", "installationId", "privateKeyPath"]],
    ["app ID only", ["appId"], ["installationId", "privateKeyPath"]],
    ["installation ID only", ["installationId"], ["appId", "privateKeyPath"]],
    ["private key path only", ["privateKeyPath"], ["appId", "installationId"]],
    [
      "app and installation IDs",
      ["appId", "installationId"],
      ["privateKeyPath"],
    ],
    [
      "app ID and private key path",
      ["appId", "privateKeyPath"],
      ["installationId"],
    ],
    [
      "installation ID and private key path",
      ["installationId", "privateKeyPath"],
      ["appId"],
    ],
  ])(
    "rejects an incomplete GitHub App configuration: %s",
    (_label, suppliedFields, missingFields) => {
      let thrown: unknown;

      try {
        parseConfig(configWithGithubApp(suppliedFields));
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);

      if (thrown instanceof Error) {
        for (const field of missingFields) {
          expect(thrown.message).toContain(
            `projects.0.repository.githubApp.${field}`,
          );
        }
      }
    },
  );

  it.each([
    ["blank app ID", "appId", '"  "', "Must not be blank"],
    ["blank installation ID", "installationId", '"  "', "Must not be blank"],
    [
      "relative private key path",
      "privateKeyPath",
      '"keys/private-key.pem"',
      "Must be an absolute path",
    ],
    ["blank private key path", "privateKeyPath", '"  "', "Must not be blank"],
    ["numeric app ID", "appId", "123456", "expected string"],
    ["numeric installation ID", "installationId", "987654", "expected string"],
  ] as const)(
    "rejects an invalid GitHub App value: %s",
    (_label, field, value, message) => {
      const raw = configWithGithubAppValues({ [field]: value });

      expect(() => parseConfig(raw)).toThrow(
        `projects.0.repository.githubApp.${field}`,
      );
      expect(() => parseConfig(raw)).toThrow(message);
    },
  );

  it("rejects unknown GitHub App configuration keys", () => {
    const raw = configWithGithubApp([
      "appId",
      "installationId",
      "privateKeyPath",
    ]).replace(
      '        privateKeyPath: "/tmp/github-app-key/../private-key.pem"',
      '        privateKeyPath: "/tmp/github-app-key/../private-key.pem"\n        privateKeyPth: "/tmp/typo.pem"',
    );

    expect(() => parseConfig(raw)).toThrow("projects.0.repository.githubApp");
    expect(() => parseConfig(raw)).toThrow("Unrecognized key");
  });

  it("accepts optional finite attachment limits", () => {
    const raw = validConfig.replace(
      "  pollIntervalSeconds: 15",
      "  pollIntervalSeconds: 15\n  maxAttachmentBytes: 1048576\n  maxTotalAttachmentBytes: 4194304",
    );

    expect(parseConfig(raw).workflow).toMatchObject({
      maxAttachmentBytes: 1_048_576,
      maxTotalAttachmentBytes: 4_194_304,
    });
  });

  it.each([
    ["maxAttachmentBytes", "0"],
    ["maxAttachmentBytes", "1.5"],
    ["maxTotalAttachmentBytes", "0"],
    ["maxTotalAttachmentBytes", "1.5"],
  ])("rejects invalid attachment limit %s: %s", (name, value) => {
    const raw = validConfig.replace(
      "  pollIntervalSeconds: 15",
      `  pollIntervalSeconds: 15\n  ${name}: ${value}`,
    );

    expect(() => parseConfig(raw)).toThrow("Invalid configuration");
  });

  it.each([0, 3])("accepts maxPasses: %s", (maxPasses) => {
    const raw = validConfig.replace(
      `      remediation:
        model: "openai/remediation-model"
        variant: "xhigh"`,
      `      remediation:
        model: "openai/remediation-model"
        variant: "xhigh"
        maxPasses: ${maxPasses}`,
    );

    expect(parseConfig(raw).projects[0]?.opencode.remediation.maxPasses).toBe(
      maxPasses,
    );
  });

  it.each([
    ["negative", "-1"],
    ["fractional", "1.5"],
    ["non-numeric", '"three"'],
    ["boolean", "true"],
    ["null", "null"],
    ["array", "[]"],
    ["object", "{}"],
  ])("rejects a %s maxPasses value", (_label, value) => {
    const raw = validConfig.replace(
      `      remediation:
        model: "openai/remediation-model"
        variant: "xhigh"`,
      `      remediation:
        model: "openai/remediation-model"
        variant: "xhigh"
        maxPasses: ${value}`,
    );

    expect(() => parseConfig(raw)).toThrow(
      "projects.0.opencode.remediation.maxPasses",
    );
  });

  it("rejects unsupported remediation configuration keys", () => {
    const raw = validConfig.replace(
      '        variant: "xhigh"\n      commit:',
      '        variant: "xhigh"\n        maxPassesTypo: 1\n      commit:',
    );

    expect(() => parseConfig(raw)).toThrow("projects.0.opencode.remediation");
  });

  it("accepts opt-in automatic merging for a project", () => {
    const raw = validConfig.replace(
      '  - id: "project-one"',
      '  - id: "project-one"\n    autoMerge: true',
    );

    expect(parseConfig(raw).projects[0]?.autoMerge).toBe(true);
  });

  it.each([
    ["non-boolean", '    autoMerge: "yes"'],
    ["unknown", "    automaticMerge: true"],
  ])("rejects a project auto-merge setting that is %s", (_label, setting) => {
    const raw = validConfig.replace(
      '  - id: "project-one"',
      `  - id: "project-one"\n${setting}`,
    );

    expect(() => parseConfig(raw)).toThrow("projects.0");
  });

  it("accepts enabled email notification settings", () => {
    const raw = validConfig.replace(
      "\nworkflow:",
      `
notifications:
  email:
    enabled: true
    recipients:
      - "reviewers@example.com"
    from: "agent-orchestrator@example.com"
    smtp:
      host: "smtp.example.com"
      port: 465
      secure: true
      usernameEnv: "SMTP_USERNAME"
      passwordEnv: "SMTP_PASSWORD"

workflow:`,
    );

    expect(parseConfig(raw).notifications?.email).toEqual({
      enabled: true,
      recipients: ["reviewers@example.com"],
      from: "agent-orchestrator@example.com",
      smtp: {
        host: "smtp.example.com",
        port: 465,
        secure: true,
        usernameEnv: "SMTP_USERNAME",
        passwordEnv: "SMTP_PASSWORD",
        timeoutSeconds: 30,
      },
    });
  });

  it("accepts all email notification event settings", () => {
    const raw = validConfig.replace(
      "\nworkflow:",
      `
notifications:
  email:
    enabled: true
    events:
      humanReview: false
      failed: true
      refinementComplete: false
      done: true
      attentionRequired: false
    recipients:
      - "reviewers@example.com"
    from: "agent-orchestrator@example.com"
    smtp:
      host: "smtp.example.com"
      port: 465
      secure: true
      usernameEnv: "SMTP_USERNAME"
      passwordEnv: "SMTP_PASSWORD"

workflow:`,
    );

    expect(parseConfig(raw).notifications?.email?.events).toEqual({
      humanReview: false,
      failed: true,
      refinementComplete: false,
      done: true,
      attentionRequired: false,
    });
  });

  it("accepts partial email notification event settings", () => {
    const raw = validConfig.replace(
      "\nworkflow:",
      `
notifications:
  email:
    enabled: true
    events:
      failed: false
    recipients:
      - "reviewers@example.com"
    from: "agent-orchestrator@example.com"
    smtp:
      host: "smtp.example.com"
      port: 465
      secure: true
      usernameEnv: "SMTP_USERNAME"
      passwordEnv: "SMTP_PASSWORD"

workflow:`,
    );

    expect(parseConfig(raw).notifications?.email?.events).toEqual({
      failed: false,
    });
  });

  it("accepts disabled email notifications without SMTP settings", () => {
    const raw = validConfig.replace(
      "\nworkflow:",
      `
notifications:
  email:
    enabled: false

workflow:`,
    );

    expect(parseConfig(raw).notifications?.email).toEqual({ enabled: false });
  });

  it.each([
    [
      "non-boolean",
      '      humanReview: "yes"',
      "notifications.email.events.humanReview",
    ],
    ["unknown", "      unexpected: false", "notifications.email.events"],
  ])(
    "rejects an %s email notification event setting",
    (_label, event, location) => {
      const raw = validConfig.replace(
        "\nworkflow:",
        `
notifications:
  email:
    enabled: false
    events:
${event}

workflow:`,
      );

      expect(() => parseConfig(raw)).toThrow(location);
    },
  );

  it.each([
    [
      "recipients",
      '    recipients:\n      - "reviewers@example.com"',
      "    recipients: []",
      "notifications.email.recipients",
    ],
    [
      "sender",
      '    from: "agent-orchestrator@example.com"',
      '    from: "not-an-email"',
      "notifications.email.from",
    ],
    [
      "SMTP host",
      '      host: "smtp.example.com"',
      '      host: ""',
      "notifications.email.smtp.host",
    ],
  ])(
    "rejects an enabled email setting with an invalid %s",
    (_label, target, replacement, location) => {
      const raw = validConfig
        .replace(
          "\nworkflow:",
          `
notifications:
  email:
    enabled: true
    recipients:
      - "reviewers@example.com"
    from: "agent-orchestrator@example.com"
    smtp:
      host: "smtp.example.com"
      port: 465
      secure: true
      usernameEnv: "SMTP_USERNAME"
      passwordEnv: "SMTP_PASSWORD"

workflow:`,
        )
        .replace(target, replacement);

      expect(() => parseConfig(raw)).toThrow(location);
    },
  );

  it("accepts a custom log retention period", () => {
    const raw = validConfig.replace(
      "pollIntervalSeconds: 15",
      "pollIntervalSeconds: 15\n  logRetentionDays: 30",
    );

    const config = parseConfig(raw);

    expect(config.workflow.logRetentionDays).toBe(30);
  });

  it("accepts a repository setup command", () => {
    const raw = validConfig.replace(
      '      validationCommand: "yarn validate"',
      '      setupCommand: "yarn install"\n      validationCommand: "yarn validate"',
    );

    const config = parseConfig(raw);

    expect(config.projects[0]?.repository.setupCommand).toBe("yarn install");
  });

  it("rejects a missing OpenCode refinement stage", () => {
    const raw = validConfig.replace(
      `      refinement:
        model: "openai/refinement-model"
        variant: "xhigh"
`,
      "",
    );

    expect(() => parseConfig(raw)).toThrow();
  });

  it("rejects a missing OpenCode review stage", () => {
    const raw = validConfig.replace(
      `      review:
        model: "openai/review-model"
        variant: "high"
`,
      "",
    );

    expect(() => parseConfig(raw)).toThrow();
  });

  it("rejects an empty OpenCode stage model", () => {
    const raw = validConfig.replace(
      'model: "openai/implementation-model"',
      'model: ""',
    );

    expect(() => parseConfig(raw)).toThrow();
  });

  it("rejects an empty OpenCode stage variant", () => {
    const raw = validConfig.replace('variant: "high"', 'variant: ""');

    expect(() => parseConfig(raw)).toThrow();
  });

  it("accepts configuration without a validation command", () => {
    const raw = validConfig.replace(
      '      validationCommand: "yarn validate"\n',
      "",
    );

    const config = parseConfig(raw);
    const project = config.projects[0];

    expect(project).toBeDefined();
    expect(project!.repository.validationCommand).toBeUndefined();
  });

  it("accepts multiple projects", () => {
    const raw = validConfig.replace(
      "\nworkflow:",
      `
  - id: "project-two"

    trello:
      boardId: "board-two"
      backlogListId: "backlog-two"
      readyListId: "ready-two"
      workingListId: "working-two"
      reviewListId: "review-two"
      failedListId: "failed-two"
      doneListId: "done-two"
      refinementLabelId: "refinement-two"
      featureLabelId: "feature-two"
      improvementLabelId: "improvement-two"
      bugLabelId: "bug-two"

    repository:
      path: "/tmp/repository-two"
      github: "owner/repository-two"
      defaultBranch: "main"
      worktreeRoot: "/tmp/worktrees-two"
      validationCommand: "yarn validate"
      gitIdentity:
        name: "Agent Orchestrator"
        email: "agent-orchestrator@users.noreply.github.com"

    opencode:
      timeoutMinutes: 360
      refinement:
        model: "openai/refinement-model"
        variant: "xhigh"
      implementation:
        model: "openai/implementation-model"
        variant: "xhigh"
      review:
        model: "openai/review-model"
        variant: "high"
      remediation:
        model: "openai/remediation-model"
        variant: "xhigh"
      commit:
        model: "openai/commit-model"
        variant: "low"

workflow:`,
    );

    const config = parseConfig(raw);

    expect(config.projects).toHaveLength(2);

    const secondProject = config.projects[1];

    expect(secondProject).toBeDefined();
    expect(secondProject!.id).toBe("project-two");
  });

  it("rejects an empty project list", () => {
    const raw = `
projects: []

workflow:
  pollIntervalSeconds: 15
`;

    expect(() => parseConfig(raw)).toThrow();
  });

  it("rejects relative repository paths", () => {
    const raw = validConfig.replace(
      'path: "/tmp/repository"',
      'path: "./repository"',
    );

    expect(() => parseConfig(raw)).toThrow("Must be an absolute path");
  });

  it("accepts and normalizes a custom context root", () => {
    const raw = validConfig.replace(
      "pollIntervalSeconds: 15",
      'pollIntervalSeconds: 15\n  contextRoot: "/tmp/card-context/."',
    );

    expect(parseConfig(raw).workflow.contextRoot).toBe("/tmp/card-context");
  });

  it.each([
    ["relative", 'contextRoot: "./card-context"', "Must be an absolute path"],
    ["blank", 'contextRoot: "  "', "Must not be blank"],
  ])("rejects a %s context root", (_label, setting, message) => {
    const raw = validConfig.replace(
      "pollIntervalSeconds: 15",
      `pollIntervalSeconds: 15\n  ${setting}`,
    );

    expect(() => parseConfig(raw)).toThrow(message);
  });

  it("rejects unknown workflow keys", () => {
    const raw = validConfig.replace(
      "pollIntervalSeconds: 15",
      "pollIntervalSeconds: 15\n  contextRoots: /tmp/card-context",
    );

    expect(() => parseConfig(raw)).toThrow("Unrecognized key");
  });

  it.each([
    ["repository path", "/tmp/repository"],
    ["inside repository path", "/tmp/repository/context"],
    ["containing repository path", "/tmp"],
    ["filesystem root", "/"],
    ["worktree root", "/tmp/worktrees"],
    ["inside worktree root", "/tmp/worktrees/context"],
    ["containing worktree root", "/tmp"],
  ])("rejects a context root overlapping the %s", (_label, contextRoot) => {
    const raw = validConfig.replace(
      "pollIntervalSeconds: 15",
      `pollIntervalSeconds: 15\n  contextRoot: "${contextRoot}"`,
    );

    expect(() => parseConfig(raw)).toThrow("Context root");
  });

  it("rejects normalized context root overlap", () => {
    const raw = validConfig.replace(
      "pollIntervalSeconds: 15",
      'pollIntervalSeconds: 15\n  contextRoot: "/tmp/worktrees/."',
    );

    expect(() => parseConfig(raw)).toThrow("Context root");
  });

  it("rejects malformed GitHub repository names", () => {
    const raw = validConfig.replace(
      'github: "owner/repository"',
      'github: "repository"',
    );

    expect(() => parseConfig(raw)).toThrow("owner/repository");
  });

  it("rejects duplicate Trello workflow list IDs", () => {
    const raw = validConfig.replace(
      'workingListId: "working"',
      'workingListId: "ready"',
    );

    expect(() => parseConfig(raw)).toThrow(
      "Trello workflow list IDs must be unique",
    );
  });

  it("rejects a backlog list ID that duplicates another workflow list", () => {
    const raw = validConfig.replace(
      'backlogListId: "backlog"',
      'backlogListId: "ready"',
    );

    expect(() => parseConfig(raw)).toThrow(
      "Trello workflow list IDs must be unique",
    );
  });

  it("rejects duplicate Trello workflow label IDs", () => {
    const raw = validConfig.replace(
      'bugLabelId: "bug"',
      'bugLabelId: "feature"',
    );

    expect(() => parseConfig(raw)).toThrow(
      "Trello workflow label IDs must be unique",
    );
  });

  it("accepts multiple projects with unique IDs", () => {
    const config = parseConfig(
      configWithProjectIds(["project-one", "project-two"]),
    );

    expect(config.projects.map((project) => project.id)).toEqual([
      "project-one",
      "project-two",
    ]);
  });

  it("rejects duplicate project IDs", () => {
    const raw = validConfig.replace(
      "\nworkflow:",
      `
  - id: "project-one"

    trello:
      boardId: "board-two"
      backlogListId: "backlog-two"
      readyListId: "ready-two"
      workingListId: "working-two"
      reviewListId: "review-two"
      failedListId: "failed-two"
      doneListId: "done-two"
      refinementLabelId: "refinement-two"
      featureLabelId: "feature-two"
      improvementLabelId: "improvement-two"
      bugLabelId: "bug-two"

    repository:
      path: "/tmp/repository-two"
      github: "owner/repository-two"
      defaultBranch: "main"
      worktreeRoot: "/tmp/worktrees-two"
      validationCommand: "yarn validate"
      gitIdentity:
        name: "Agent Orchestrator"
        email: "agent-orchestrator@users.noreply.github.com"

    opencode:
      timeoutMinutes: 360
      refinement:
        model: "openai/refinement-model"
        variant: "xhigh"
      implementation:
        model: "openai/implementation-model"
        variant: "xhigh"
      review:
        model: "openai/review-model"
        variant: "high"
      remediation:
        model: "openai/remediation-model"
        variant: "xhigh"
      commit:
        model: "openai/commit-model"
        variant: "low"

workflow:`,
    );

    expect(() => parseConfig(raw)).toThrow(
      'Duplicate project ID "project-one"',
    );
  });

  it("rejects a project ID that occurs more than twice", () => {
    expect(() =>
      parseConfig(
        configWithProjectIds(["project-one", "project-one", "project-one"]),
      ),
    ).toThrow('Duplicate project ID "project-one"');
  });

  it("rejects duplicate GitHub repositories", () => {
    const raw = validConfig.replace(
      "\nworkflow:",
      `
  - id: "project-two"

    trello:
      boardId: "board-two"
      backlogListId: "backlog-two"
      readyListId: "ready-two"
      workingListId: "working-two"
      reviewListId: "review-two"
      failedListId: "failed-two"
      doneListId: "done-two"
      refinementLabelId: "refinement-two"
      featureLabelId: "feature-two"
      improvementLabelId: "improvement-two"
      bugLabelId: "bug-two"

    repository:
      path: "/tmp/repository-two"
      github: "owner/repository"
      defaultBranch: "main"
      worktreeRoot: "/tmp/worktrees-two"
      validationCommand: "yarn validate"
      gitIdentity:
        name: "Agent Orchestrator"
        email: "agent-orchestrator@users.noreply.github.com"

    opencode:
      timeoutMinutes: 360
      refinement:
        model: "openai/refinement-model"
        variant: "xhigh"
      implementation:
        model: "openai/implementation-model"
        variant: "xhigh"
      review:
        model: "openai/review-model"
        variant: "high"
      remediation:
        model: "openai/remediation-model"
        variant: "xhigh"
      commit:
        model: "openai/commit-model"
        variant: "low"

workflow:`,
    );

    expect(() => parseConfig(raw)).toThrow(
      "GitHub repositories must be unique",
    );
  });

  it("rejects duplicate Trello board IDs", () => {
    const raw = validConfig.replace(
      "\nworkflow:",
      `
  - id: "project-two"

    trello:
      boardId: "board-one"
      backlogListId: "backlog-two"
      readyListId: "ready-two"
      workingListId: "working-two"
      reviewListId: "review-two"
      failedListId: "failed"
      doneListId: "done-two"
      refinementLabelId: "refinement-two"
      featureLabelId: "feature-two"
      improvementLabelId: "improvement-two"
      bugLabelId: "bug-two"

    repository:
      path: "/tmp/repository-two"
      github: "owner/repository-two"
      defaultBranch: "main"
      worktreeRoot: "/tmp/worktrees-two"
      validationCommand: "yarn validate"
      gitIdentity:
        name: "Agent Orchestrator"
        email: "agent-orchestrator@users.noreply.github.com"

    opencode:
      timeoutMinutes: 360
      refinement:
        model: "openai/refinement-model"
        variant: "xhigh"
      implementation:
        model: "openai/implementation-model"
        variant: "xhigh"
      review:
        model: "openai/review-model"
        variant: "high"
      remediation:
        model: "openai/remediation-model"
        variant: "xhigh"
      commit:
        model: "openai/commit-model"
        variant: "low"

workflow:`,
    );

    expect(() => parseConfig(raw)).toThrow("Trello board IDs must be unique");
  });

  it("rejects non-positive poll intervals", () => {
    const raw = validConfig.replace(
      "pollIntervalSeconds: 15",
      "pollIntervalSeconds: 0",
    );

    expect(() => parseConfig(raw)).toThrow();
  });

  it.each([
    ["zero", "0"],
    ["negative", "-1"],
    ["fractional", "1.5"],
    ["non-numeric", '"fourteen"'],
    ["malformed", "{}"],
  ])("rejects a %s log retention period", (_label, value) => {
    const raw = validConfig.replace(
      "pollIntervalSeconds: 15",
      `pollIntervalSeconds: 15\n  logRetentionDays: ${value}`,
    );

    expect(() => parseConfig(raw)).toThrow("workflow.logRetentionDays");
  });

  it("accepts a custom context retention period", () => {
    const raw = validConfig.replace(
      "pollIntervalSeconds: 15",
      "pollIntervalSeconds: 15\n  contextRetentionDays: 30",
    );

    expect(parseConfig(raw).workflow.contextRetentionDays).toBe(30);
  });

  it.each([
    ["zero", "0"],
    ["negative", "-1"],
    ["fractional", "1.5"],
    ["non-numeric", '"fourteen"'],
    ["malformed", "{}"],
  ])("rejects a %s context retention period", (_label, value) => {
    const raw = validConfig.replace(
      "pollIntervalSeconds: 15",
      `pollIntervalSeconds: 15\n  contextRetentionDays: ${value}`,
    );

    expect(() => parseConfig(raw)).toThrow("workflow.contextRetentionDays");
  });

  it("rejects an empty validation command", () => {
    const raw = validConfig.replace(
      'validationCommand: "yarn validate"',
      'validationCommand: ""',
    );

    expect(() => parseConfig(raw)).toThrow();
  });

  it("rejects whitespace-only identifiers", () => {
    const raw = validConfig.replace('boardId: "board-one"', 'boardId: " "');

    expect(() => parseConfig(raw)).toThrow("Must not be blank");
  });

  it.each([
    ["separator", "project/one"],
    ["traversal", "../project"],
    ["absolute", "/project"],
    ["NUL-containing", "project\0one"],
  ])("rejects an unsafe project ID: %s", (_label, projectId) => {
    const raw = validConfig.replace('id: "project-one"', `id: "${projectId}"`);

    expect(() => parseConfig(raw)).toThrow("projects.0.id");
  });

  it("rejects unknown configuration keys instead of silently ignoring typos", () => {
    const raw = validConfig.replace(
      'validationCommand: "yarn validate"',
      'validationComand: "yarn validate"\n      validationCommand: "yarn validate"',
    );

    expect(() => parseConfig(raw)).toThrow("Unrecognized key");
  });

  it("normalizes equivalent repository paths before checking uniqueness", () => {
    const raw = validConfig.replace(
      "\nworkflow:",
      `
  - id: "project-two"

    trello:
      boardId: "board-two"
      backlogListId: "backlog-two"
      readyListId: "ready-two"
      workingListId: "working-two"
      reviewListId: "review-two"
      failedListId: "failed-two"
      doneListId: "done-two"
      refinementLabelId: "refinement-two"
      featureLabelId: "feature-two"
      improvementLabelId: "improvement-two"
      bugLabelId: "bug-two"

    repository:
      path: "/tmp/repository/."
      github: "owner/repository-two"
      defaultBranch: "main"
      worktreeRoot: "/tmp/worktrees-two"
      gitIdentity:
        name: "Agent Orchestrator"
        email: "agent-orchestrator@users.noreply.github.com"

    opencode:
      timeoutMinutes: 360
      refinement:
        model: "openai/refinement-model"
        variant: "xhigh"
      implementation:
        model: "openai/implementation-model"
        variant: "xhigh"
      review:
        model: "openai/review-model"
        variant: "high"
      remediation:
        model: "openai/remediation-model"
        variant: "xhigh"
      commit:
        model: "openai/commit-model"
        variant: "low"

workflow:`,
    );

    expect(() => parseConfig(raw)).toThrow("Repository paths must be unique");
  });

  it("rejects malformed YAML", () => {
    expect(() => parseConfig("projects: [")).toThrow("Invalid YAML");
  });
});
