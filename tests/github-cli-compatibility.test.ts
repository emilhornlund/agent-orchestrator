import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import {
  GITHUB_CLI_COMMAND_CAPABILITIES,
  GitHubCliCompatibilityError,
  type RunGitHubCliCompatibilityCommand,
  validateGitHubCliCompatibility,
} from "../src/github/github-cli-compatibility.js";

const project = {
  repository: { github: "owner/repository" },
} as ProjectConfig;

function helpOutput(): string {
  return GITHUB_CLI_COMMAND_CAPABILITIES.flatMap(
    (capability) => capability.requiredHelpOptions,
  ).join(" ");
}

function supportedRun(): ReturnType<typeof vi.fn<RunGitHubCliCompatibilityCommand>> {
  return vi
    .fn<RunGitHubCliCompatibilityCommand>()
    .mockResolvedValueOnce("gh version 2.40.0 (2026-01-01)\nhttps://github.com/cli/cli")
    .mockImplementationOnce(async () => helpOutput())
    .mockImplementationOnce(async () => helpOutput())
    .mockImplementationOnce(async () => helpOutput())
    .mockImplementationOnce(async () => helpOutput())
    .mockImplementationOnce(async () => helpOutput());
}

describe("validateGitHubCliCompatibility", () => {
  it("accepts a supported gh version and all required capabilities", async () => {
    expect(
      GITHUB_CLI_COMMAND_CAPABILITIES.some((capability) => capability.name.includes("pr merge")),
    ).toBe(false);
    const run = supportedRun();

    await expect(validateGitHubCliCompatibility(run, [])).resolves.toBe(undefined);
    expect(run).toHaveBeenCalledTimes(1 + GITHUB_CLI_COMMAND_CAPABILITIES.length);
  });

  it("rejects a too-old gh version before checking commands", async () => {
    const run = vi.fn<RunGitHubCliCompatibilityCommand>().mockResolvedValue("gh version 2.39.0");

    await expect(validateGitHubCliCompatibility(run, [project])).rejects.toThrow(
      new GitHubCliCompatibilityError(
        "installed gh version 2.39.0 is unsupported; Agent Orchestrator requires gh 2.40.0 or newer",
      ),
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed gh version output", async () => {
    const run = vi
      .fn<RunGitHubCliCompatibilityCommand>()
      .mockResolvedValue("GitHub CLI is installed");

    await expect(validateGitHubCliCompatibility(run, [project])).rejects.toThrow(
      'gh --version returned malformed output; expected a line like "gh version 2.40.0"',
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects unavailable gh version output", async () => {
    const run = vi
      .fn<RunGitHubCliCompatibilityCommand>()
      .mockRejectedValue(new Error("spawn gh ENOENT"));

    await expect(validateGitHubCliCompatibility(run, [project])).rejects.toThrow(
      "gh version output is unavailable: spawn gh ENOENT",
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects a command that does not expose a required option", async () => {
    const run = vi
      .fn<RunGitHubCliCompatibilityCommand>()
      .mockResolvedValueOnce("gh version 2.40.0")
      .mockResolvedValueOnce(helpOutput())
      .mockResolvedValueOnce(helpOutput())
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");

    await expect(validateGitHubCliCompatibility(run, [project])).rejects.toThrow(
      "gh pr list is missing required options",
    );
  });

  it("does not probe repository authentication while checking executable compatibility", async () => {
    const run = supportedRun();
    await expect(validateGitHubCliCompatibility(run, [project])).resolves.toBe(undefined);
    expect(run.mock.calls.some((call) => call[0].includes("--repo"))).toBe(false);
  });
});
