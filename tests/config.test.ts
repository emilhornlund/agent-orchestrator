import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/config.js";

const validConfig = `
trello:
  boardId: "board"
  readyListId: "ready"
  workingListId: "working"
  reviewListId: "review"
  doneListId: "done"

repository:
  path: "/tmp/repository"
  github: "owner/repository"
  defaultBranch: "main"
  worktreeRoot: "/tmp/worktrees"

opencode:
  model: "openai/model"
  variant: "xhigh"

workflow:
  pollIntervalSeconds: 15
`;

describe("parseConfig", () => {
  it("accepts valid configuration", () => {
    const config = parseConfig(validConfig);

    expect(config.repository.github).toBe("owner/repository");
    expect(config.workflow.pollIntervalSeconds).toBe(15);
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

  it("rejects non-positive poll intervals", () => {
    const raw = validConfig.replace(
      "pollIntervalSeconds: 15",
      "pollIntervalSeconds: 0",
    );

    expect(() => parseConfig(raw)).toThrow();
  });

  it("rejects malformed YAML", () => {
    expect(() => parseConfig("trello: [")).toThrow("Invalid YAML");
  });
});
