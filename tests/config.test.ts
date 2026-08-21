import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/config.js";

const validConfig = `
projects:
  - id: "project-one"

    trello:
      boardId: "board-one"
      readyListId: "ready"
      workingListId: "working"
      reviewListId: "review"
      doneListId: "done"

    repository:
      path: "/tmp/repository"
      github: "owner/repository"
      defaultBranch: "main"
      worktreeRoot: "/tmp/worktrees"
      validationCommand: "yarn validate"

    opencode:
      model: "openai/model"
      variant: "xhigh"

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
    expect(project!.repository.github).toBe("owner/repository");
    expect(project!.repository.validationCommand).toBe("yarn validate");
    expect(config.workflow.pollIntervalSeconds).toBe(15);
  });

  it("accepts multiple projects", () => {
    const raw = validConfig.replace(
      "\nworkflow:",
      `
  - id: "project-two"

    trello:
      boardId: "board-two"
      readyListId: "ready-two"
      workingListId: "working-two"
      reviewListId: "review-two"
      doneListId: "done-two"

    repository:
      path: "/tmp/repository-two"
      github: "owner/repository-two"
      defaultBranch: "main"
      worktreeRoot: "/tmp/worktrees-two"
      validationCommand: "yarn validate"

    opencode:
      model: "openai/model"
      variant: "xhigh"

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

  it("rejects duplicate project IDs", () => {
    const raw = validConfig.replace(
      "\nworkflow:",
      `
  - id: "project-one"

    trello:
      boardId: "board-two"
      readyListId: "ready-two"
      workingListId: "working-two"
      reviewListId: "review-two"
      doneListId: "done-two"

    repository:
      path: "/tmp/repository-two"
      github: "owner/repository-two"
      defaultBranch: "main"
      worktreeRoot: "/tmp/worktrees-two"
      validationCommand: "yarn validate"

    opencode:
      model: "openai/model"
      variant: "xhigh"

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
      readyListId: "ready-two"
      workingListId: "working-two"
      reviewListId: "review-two"
      doneListId: "done-two"

    repository:
      path: "/tmp/repository-two"
      github: "owner/repository"
      defaultBranch: "main"
      worktreeRoot: "/tmp/worktrees-two"
      validationCommand: "yarn validate"

    opencode:
      model: "openai/model"
      variant: "xhigh"

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
      readyListId: "ready-two"
      workingListId: "working-two"
      reviewListId: "review-two"
      doneListId: "done-two"

    repository:
      path: "/tmp/repository-two"
      github: "owner/repository-two"
      defaultBranch: "main"
      worktreeRoot: "/tmp/worktrees-two"
      validationCommand: "yarn validate"

    opencode:
      model: "openai/model"
      variant: "xhigh"

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

  it("rejects malformed YAML", () => {
    expect(() => parseConfig("projects: [")).toThrow("Invalid YAML");
  });
});
