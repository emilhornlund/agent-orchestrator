import { describe, expect, it } from "vitest";

import {
  AGENT_ORCHESTRATOR_STATUS_END,
  AGENT_ORCHESTRATOR_STATUS_START,
  MalformedManagedPullRequestStatusError,
  reconcileManagedPullRequestStatus,
} from "../src/github/pull-request-status.js";

const block = (message: string): string =>
  [
    AGENT_ORCHESTRATOR_STATUS_START,
    message,
    AGENT_ORCHESTRATOR_STATUS_END,
  ].join("\n");

describe("reconcileManagedPullRequestStatus", () => {
  it("adds a managed section without replacing the existing description", () => {
    const body = "Human-written context\n\n<!-- another tool's content -->";

    const result = reconcileManagedPullRequestStatus(body, "rebasing", "main");

    expect(result).toBe(
      `${body}\n\n${block("Agent Orchestrator status: rebasing onto the latest configured default branch (main).")}`,
    );
  });

  it("updates an existing section while preserving arbitrary surrounding content", () => {
    const before = "Intro\n\n";
    const after = "\n\nFooter\n<!-- unrelated marker -->";
    const body = `${before}${block("old status")}${after}`;

    const result = reconcileManagedPullRequestStatus(
      body,
      "validating",
      "main",
    );

    expect(result).toBe(
      `${before}${block("Agent Orchestrator status: running repository validation before updating the task branch.")}${after}`,
    );
  });

  it("removes the section after successful maintenance", () => {
    const body = `Human-written context\n\n${block("status")}\n\nRelease notes`;

    expect(reconcileManagedPullRequestStatus(body, null, "main")).toBe(
      "Human-written context\n\n\n\nRelease notes",
    );
  });

  it("does not change an identical status update", () => {
    const body = block(
      "Agent Orchestrator status: updating the remote task branch.",
    );

    expect(
      reconcileManagedPullRequestStatus(body, "updating-remote", "main"),
    ).toBe(body);
  });

  it("writes an explicit human-attention failure status", () => {
    const result = reconcileManagedPullRequestStatus(
      "Description",
      "failed",
      "main",
    );

    expect(result).toContain("branch maintenance failed");
    expect(result).toContain("Human attention is required");
    expect(result).not.toContain("successfully maintained");
  });

  it.each([
    `${AGENT_ORCHESTRATOR_STATUS_START}\none\n${AGENT_ORCHESTRATOR_STATUS_START}\ntwo\n${AGENT_ORCHESTRATOR_STATUS_END}`,
    `${AGENT_ORCHESTRATOR_STATUS_END}\n${AGENT_ORCHESTRATOR_STATUS_START}`,
    `${AGENT_ORCHESTRATOR_STATUS_START}\nmissing end`,
    `missing start\n${AGENT_ORCHESTRATOR_STATUS_END}`,
  ])("fails closed for malformed marker structure", (body) => {
    expect(() =>
      reconcileManagedPullRequestStatus(body, "rebasing", "main"),
    ).toThrow(MalformedManagedPullRequestStatusError);
    expect(() => reconcileManagedPullRequestStatus(body, null, "main")).toThrow(
      MalformedManagedPullRequestStatusError,
    );
  });
});
