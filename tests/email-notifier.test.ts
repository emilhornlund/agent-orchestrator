import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import type { Logger } from "../src/logging/logger.js";
import {
  buildCompletionEmail,
  buildFailedEmail,
  buildHumanReviewEmail,
  buildAttentionRequiredEmail,
  buildRefinementCompletionEmail,
  createEmailNotifier,
  notifyAttentionRequired,
  notifyCompletion,
  notifyFailed,
  notifyHumanReview,
  notifyRefinementCompletion,
  type EmailNotifier,
} from "../src/notifications/email-notifier.js";
import type { TrelloCard } from "../src/trello/trello-client.js";
import { MAX_EXTERNAL_DIAGNOSTIC_LENGTH } from "../src/security/bounded-diagnostic.js";

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
      createEmailNotifier(
        {
          enabled: false,
          events: {
            humanReview: false,
            failed: false,
            refinementComplete: false,
            done: false,
            attentionRequired: false,
          },
        },
        {} as NodeJS.ProcessEnv,
      ),
    ).toBeUndefined();
  });

  it("retains SMTP validation when all email events are disabled", () => {
    expect(() =>
      createEmailNotifier(
        {
          enabled: true,
          events: {
            humanReview: false,
            failed: false,
            refinementComplete: false,
            done: false,
            attentionRequired: false,
          },
        },
        {},
      ),
    ).toThrow("notifications.email.recipients");
  });

  it("creates an SMTP notifier with valid settings and environment secrets", () => {
    expect(
      createEmailNotifier(emailConfig, {
        SMTP_USERNAME: "smtp-user",
        SMTP_PASSWORD: "smtp-password",
      }),
    ).toBeDefined();
  });

  it("applies configured event settings while defaulting omitted events to enabled", () => {
    const notifier = createEmailNotifier(
      {
        ...emailConfig,
        events: {
          failed: false,
        },
      },
      {
        SMTP_USERNAME: "smtp-user",
        SMTP_PASSWORD: "smtp-password",
      },
    );

    expect(notifier?.isEventEnabled?.("failed")).toBe(false);

    for (const event of [
      "humanReview",
      "refinementComplete",
      "done",
      "attentionRequired",
    ] as const) {
      expect(notifier?.isEventEnabled?.(event)).toBe(true);
    }
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
        elapsedWorkflowTime: "1 hour 5 minutes",
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
        "Elapsed workflow time: 1 hour 5 minutes",
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

  it("builds an Attention Required message with project diagnostics", () => {
    expect(
      buildAttentionRequiredEmail({
        project,
        category: "Workflow",
        reason: "Multiple active cards are in Working: card-1, card-2",
        cardIds: ["card-1", "card-2"],
        sessionLogPaths: [
          "logs/sessions/project/card-1.log",
          "logs/sessions/project/card-2.log",
        ],
      }),
    ).toEqual({
      subject: "[Agent Orchestrator] Attention Required: project-one",
      text: [
        "Event: Attention Required",
        "Project: project-one",
        "Failure category: Workflow",
        "Failure reason: Multiple active cards are in Working: card-1, card-2",
        "Affected card IDs: card-1, card-2",
        "Session logs:",
        "- logs/sessions/project/card-1.log",
        "- logs/sessions/project/card-2.log",
        "",
        "Project processing cannot safely continue until the failure is resolved.",
      ].join("\n"),
    });
  });

  it("bounds failed and Attention Required diagnostic values independently", () => {
    const reason = "failure output ".repeat(300);
    const handlingOutcome = "recovery outcome ".repeat(300);

    const failed = buildFailedEmail({
      project,
      card,
      category: "Workflow",
      reason,
    });
    const attention = buildAttentionRequiredEmail({
      project,
      category: "Workflow",
      reason,
      handlingOutcome,
    });

    expect(failed.text).toContain(
      `Failure reason: ${"failure output ".repeat(
        Math.floor(
          (MAX_EXTERNAL_DIAGNOSTIC_LENGTH - "... [truncated]".length) /
            "failure output ".length,
        ),
      )}`,
    );
    expect(failed.text).toContain("... [truncated]");
    expect(failed.text).toContain(
      "To retry deliberately, move this card to Ready for Agent.",
    );
    expect(attention.text).toContain("Failure reason: ");
    expect(attention.text).toContain("Failure handling: ");
    expect(attention.text.match(/\.\.\. \[truncated\]/g)).toHaveLength(2);
    expect(attention.text).toContain(
      "Project processing cannot safely continue until the failure is resolved.",
    );
  });

  it("does not attempt Attention Required delivery without a notifier", async () => {
    const notifier = createEmailNotifier({ enabled: false }, {});

    await notifyAttentionRequired(
      notifier,
      {
        project,
        category: "Workflow",
        reason: "Project state is ambiguous",
      },
      { event: vi.fn(), error: vi.fn() } as unknown as Logger,
    );

    expect(notifier).toBeUndefined();
  });

  it("builds a concise refinement completion message with elapsed time", () => {
    const email = buildRefinementCompletionEmail({
      project,
      card,
      result: {
        title: "Add inventory support",
        type: "feature",
        description:
          "# Add inventory support\n\n## Description\n\nAdd inventory support.",
      },
      elapsedWorkflowTime: "1 hour 5 minutes",
    });

    expect(email).toEqual({
      subject:
        "[Agent Orchestrator] Refinement Complete: project-one / Add email notifications",
      text: [
        "Event: Refinement Complete",
        "Project: project-one",
        "Card: Add email notifications",
        "Trello card URL: https://trello.com/c/card-1",
        "Classification: feature",
        "Refined task title: Add inventory support",
        "Elapsed workflow time: 1 hour 5 minutes",
      ].join("\n"),
    });
    expect(email.text).not.toContain("Refined task description:");
    expect(email.text).not.toContain("# Add inventory support");
  });

  it("omits unavailable refinement elapsed time and description", () => {
    const email = buildRefinementCompletionEmail({
      project,
      card,
      result: {
        title: "Add inventory support",
        type: "feature",
        description: "Refined task description content",
      },
    });

    expect(email.text).toBe(
      [
        "Event: Refinement Complete",
        "Project: project-one",
        "Card: Add email notifications",
        "Trello card URL: https://trello.com/c/card-1",
        "Classification: feature",
        "Refined task title: Add inventory support",
      ].join("\n"),
    );
    expect(email.text).not.toContain("Elapsed workflow time:");
    expect(email.text).not.toContain("Refined task description:");
    expect(email.text).not.toContain("Refined task description content");
  });

  it("builds a completion message with both workflow links", () => {
    expect(
      buildCompletionEmail({
        project,
        card,
        pullRequestUrl: "https://github.com/owner/repo/pull/42",
      }),
    ).toEqual({
      subject:
        "[Agent Orchestrator] Completed: project-one / Add email notifications",
      text: [
        "Event: Completed",
        "Project: project-one",
        "Card: Add email notifications",
        "Trello card URL: https://trello.com/c/card-1",
        "Pull request URL: https://github.com/owner/repo/pull/42",
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

  it("isolates Attention Required delivery failures", async () => {
    const notifier = {
      send: vi.fn().mockRejectedValue(new Error("SMTP unavailable")),
    };
    const projectLog = {
      event: vi.fn(),
      error: vi.fn(),
    };

    await notifyAttentionRequired(
      notifier,
      {
        project,
        category: "Workflow",
        reason: "Project state is ambiguous",
      },
      projectLog as unknown as Logger,
    );

    expect(projectLog.error).toHaveBeenCalledWith(
      "Attention-required email notification failed: SMTP unavailable",
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

  it("does not attempt completion delivery without a notifier", async () => {
    const cardLog = {
      event: vi.fn(),
      error: vi.fn(),
    };

    await notifyCompletion(
      undefined,
      {
        project,
        card,
        pullRequestUrl: "https://github.com/owner/repo/pull/42",
      },
      cardLog as unknown as Logger,
    );

    expect(cardLog.event).not.toHaveBeenCalled();
    expect(cardLog.error).not.toHaveBeenCalled();
  });

  it.each([
    ["humanReview", notifyHumanReview],
    ["failed", notifyFailed],
    ["refinementComplete", notifyRefinementCompletion],
    ["done", notifyCompletion],
    ["attentionRequired", notifyAttentionRequired],
  ] as const)(
    "skips the disabled %s event without suppressing another enabled delivery",
    async (event, notify) => {
      const send = vi.fn();
      const notifier: EmailNotifier = {
        send,
        isEventEnabled: (configuredEvent) => configuredEvent !== event,
      };
      const log = {
        event: vi.fn(),
        error: vi.fn(),
      } as unknown as Logger;

      if (event === "humanReview") {
        await notify(
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
          log,
        );
      } else if (event === "failed") {
        await notify(
          notifier,
          {
            project,
            card,
            category: "Workflow",
            reason: "The pull request was closed without being merged.",
          },
          log,
        );
      } else if (event === "refinementComplete") {
        await notify(
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
          log,
        );
      } else if (event === "done") {
        await notify(
          notifier,
          {
            project,
            card,
            pullRequestUrl: "https://github.com/owner/repo/pull/42",
          },
          log,
        );
      } else {
        await notify(
          notifier,
          {
            project,
            category: "Workflow",
            reason: "Project state is ambiguous",
          },
          log,
        );
      }

      const enabledLog = {
        event: vi.fn(),
        error: vi.fn(),
      } as unknown as Logger;

      if (event === "humanReview") {
        await notifyFailed(
          notifier,
          {
            project,
            card,
            category: "Workflow",
            reason: "The pull request was closed without being merged.",
          },
          enabledLog,
        );
      } else {
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
          enabledLog,
        );
      }

      expect(send).toHaveBeenCalledTimes(1);
      expect(log.event).not.toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalled();
    },
  );

  it("isolates completion delivery failures", async () => {
    const notifier = {
      send: vi.fn().mockRejectedValue(new Error("SMTP unavailable")),
    };
    const cardLog = {
      event: vi.fn(),
      error: vi.fn(),
    };

    await notifyCompletion(
      notifier,
      {
        project,
        card,
        pullRequestUrl: "https://github.com/owner/repo/pull/42",
      },
      cardLog as unknown as Logger,
    );

    expect(cardLog.error).toHaveBeenCalledWith(
      "Completion email notification failed: SMTP unavailable",
    );
  });
});
