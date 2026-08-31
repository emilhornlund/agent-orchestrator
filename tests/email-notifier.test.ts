import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import type { Logger } from "../src/logging/logger.js";
import {
  buildFailedEmail,
  buildHumanReviewEmail,
  buildRefinementCompletionEmail,
  createEmailNotifier,
  notifyFailed,
  notifyHumanReview,
  notifyRefinementCompletion,
} from "../src/notifications/email-notifier.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

const project = { id: "project-one" } as ProjectConfig;
const card: TrelloCard = {
  id: "card-1",
  name: "Add email notifications",
  desc: "",
  idList: "working",
  idLabels: [],
  url: "https://trello.com/c/card-1",
};

const emailConfig = {
  enabled: true,
  recipients: ["reviewers@example.com", "owner@example.com"],
  from: "agent-orchestrator@example.com",
  smtp: {
    host: "smtp.example.com",
    port: 465,
    secure: true,
    usernameEnv: "SMTP_USERNAME",
    passwordEnv: "SMTP_PASSWORD",
    timeoutSeconds: 30,
  },
};

describe("email notifications", () => {
  it("does not create a notifier when email notifications are omitted or disabled", () => {
    expect(createEmailNotifier(undefined, {})).toBeUndefined();
    expect(
      createEmailNotifier({ enabled: false }, {} as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });

  it("creates an SMTP notifier with valid settings and environment secrets", () => {
    expect(
      createEmailNotifier(emailConfig, {
        SMTP_USERNAME: "smtp-user",
        SMTP_PASSWORD: "smtp-password",
      }),
    ).toBeDefined();
  });

  it("rejects a missing enabled SMTP credential without exposing secret values", () => {
    expect(() =>
      createEmailNotifier(emailConfig, {
        SMTP_USERNAME: "smtp-user",
      }),
    ).toThrow("SMTP_PASSWORD is required");
  });

  it("builds a Human Review message with publication context", () => {
    expect(
      buildHumanReviewEmail({
        project,
        card,
        pullRequestUrl: "https://github.com/owner/repo/pull/42",
        commitSha: "abc123",
        reviewResult: "Passed",
        remediationResult: "Not required",
        publicationContext: "Created a new pull request.",
      }),
    ).toEqual({
      subject:
        "[Agent Orchestrator] Human Review: project-one / Add email notifications",
      text: [
        "Event: Human Review",
        "Project: project-one",
        "Card: Add email notifications",
        "Trello card URL: https://trello.com/c/card-1",
        "Pull request URL: https://github.com/owner/repo/pull/42",
        "Commit: abc123",
        "Publication context: Created a new pull request.",
        "Review result: Passed",
        "Remediation result: Not required",
      ].join("\n"),
    });
  });

  it("builds a Failed message with retry instructions", () => {
    expect(
      buildFailedEmail({
        project,
        card,
        category: "OpenCode",
        reason: "OpenCode implementation exited with code 1",
      }),
    ).toEqual({
      subject:
        "[Agent Orchestrator] Failed: project-one / Add email notifications",
      text: [
        "Event: Failed",
        "Project: project-one",
        "Card: Add email notifications",
        "Trello card URL: https://trello.com/c/card-1",
        "Failure category: OpenCode",
        "Failure reason: OpenCode implementation exited with code 1",
        "",
        "To retry deliberately, move this card to Ready for Agent.",
      ].join("\n"),
    });
  });

  it("builds a refinement completion message with the refined task", () => {
    expect(
      buildRefinementCompletionEmail({
        project,
        card,
        result: {
          title: "Add inventory support",
          type: "feature",
          description:
            "# Add inventory support\n\n## Description\n\nAdd inventory support.",
        },
      }),
    ).toEqual({
      subject:
        "[Agent Orchestrator] Refinement Complete: project-one / Add email notifications",
      text: [
        "Event: Refinement Complete",
        "Project: project-one",
        "Card: Add email notifications",
        "Trello card URL: https://trello.com/c/card-1",
        "Classification: feature",
        "Refined task title: Add inventory support",
        "Refined task description:",
        "# Add inventory support\n\n## Description\n\nAdd inventory support.",
      ].join("\n"),
    });
  });

  it("isolates Human Review delivery failures", async () => {
    const notifier = {
      send: vi.fn().mockRejectedValue(new Error("SMTP unavailable")),
    };
    const cardLog = {
      event: vi.fn(),
      error: vi.fn(),
    };

    await notifyHumanReview(
      notifier,
      {
        project,
        card,
        pullRequestUrl: "https://github.com/owner/repo/pull/42",
        commitSha: "abc123",
        reviewResult: "Passed",
        remediationResult: "Not required",
        publicationContext: "Created a new pull request.",
      },
      cardLog as unknown as Logger,
    );

    expect(cardLog.error).toHaveBeenCalledWith(
      "Human Review email notification failed: SMTP unavailable",
    );
  });

  it("isolates Failed delivery failures", async () => {
    const notifier = {
      send: vi.fn().mockRejectedValue(new Error("SMTP unavailable")),
    };
    const cardLog = {
      event: vi.fn(),
      error: vi.fn(),
    };

    await notifyFailed(
      notifier,
      {
        project,
        card,
        category: "Workflow",
        reason: "The pull request was closed without being merged.",
      },
      cardLog as unknown as Logger,
    );

    expect(cardLog.error).toHaveBeenCalledWith(
      "Failed email notification failed: SMTP unavailable",
    );
  });

  it("isolates refinement completion delivery failures", async () => {
    const notifier = {
      send: vi.fn().mockRejectedValue(new Error("SMTP unavailable")),
    };
    const cardLog = {
      event: vi.fn(),
      error: vi.fn(),
    };

    await notifyRefinementCompletion(
      notifier,
      {
        project,
        card,
        result: {
          title: "Add inventory support",
          type: "feature",
          description: "Refined task content",
        },
      },
      cardLog as unknown as Logger,
    );

    expect(cardLog.error).toHaveBeenCalledWith(
      "Refinement completion email notification failed: SMTP unavailable",
    );
  });
});
