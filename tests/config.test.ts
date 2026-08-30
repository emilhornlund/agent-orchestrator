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

describe("parseConfig", () => {
  it("accepts valid configuration", () => {
    const config = parseConfig(validConfig);

    expect(config.projects).toHaveLength(1);

    const project = config.projects[0];

    expect(project).toBeDefined();
    expect(project!.id).toBe("project-one");
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
    });
    expect(project!.opencode.commit).toEqual({
      model: "openai/commit-model",
      variant: "low",
    });
    expect(project!.opencode.timeoutMinutes).toBe(360);
    expect(config.workflow.pollIntervalSeconds).toBe(15);
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

    expect(() => parseConfig(raw)).toThrow("Project IDs must be unique");
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
