import type { Logger } from "../logging/logger.js";
import type { TrelloCard } from "../trello/trello-client.js";

import type {
  EmailNotificationConfig,
  ProjectConfig,
} from "../config/config.js";
import { SmtpEmailNotifier } from "./smtp-email-notifier.js";

export interface EmailMessage {
  subject: string;
  text: string;
}

export interface EmailNotifier {
  send(message: EmailMessage): Promise<void>;
}

export interface HumanReviewNotificationDetails {
  project: ProjectConfig;
  card: TrelloCard;
  pullRequestUrl: string;
  commitSha: string;
  reviewResult: string;
  remediationResult: string;
  publicationContext: string;
}

export interface FailedNotificationDetails {
  project: ProjectConfig;
  card: Pick<TrelloCard, "name" | "url">;
  category: string;
  reason: string;
}

function subjectPart(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function buildHumanReviewEmail(
  details: HumanReviewNotificationDetails,
): EmailMessage {
  return {
    subject: `[Agent Orchestrator] Human Review: ${subjectPart(details.project.id)} / ${subjectPart(details.card.name)}`,
    text: [
      "Event: Human Review",
      `Project: ${details.project.id}`,
      `Card: ${details.card.name}`,
      `Trello card URL: ${details.card.url}`,
      `Pull request URL: ${details.pullRequestUrl}`,
      `Commit: ${details.commitSha}`,
      `Publication context: ${details.publicationContext}`,
      `Review result: ${details.reviewResult}`,
      `Remediation result: ${details.remediationResult}`,
    ].join("\n"),
  };
}

export function buildFailedEmail(
  details: FailedNotificationDetails,
): EmailMessage {
  return {
    subject: `[Agent Orchestrator] Failed: ${subjectPart(details.project.id)} / ${subjectPart(details.card.name)}`,
    text: [
      "Event: Failed",
      `Project: ${details.project.id}`,
      `Card: ${details.card.name}`,
      `Trello card URL: ${details.card.url}`,
      `Failure category: ${details.category}`,
      `Failure reason: ${details.reason}`,
      "",
      "To retry deliberately, move this card to Ready for Agent.",
    ].join("\n"),
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function notifyHumanReview(
  notifier: EmailNotifier | undefined,
  details: HumanReviewNotificationDetails,
  cardLog: Logger,
): Promise<void> {
  if (notifier === undefined) {
    return;
  }

  try {
    await notifier.send(buildHumanReviewEmail(details));
    cardLog.event("Human Review email notification sent");
  } catch (error) {
    cardLog.error(
      `Human Review email notification failed: ${getErrorMessage(error)}`,
    );
  }
}

export async function notifyFailed(
  notifier: EmailNotifier | undefined,
  details: FailedNotificationDetails,
  cardLog: Logger,
): Promise<void> {
  if (notifier === undefined) {
    return;
  }

  try {
    await notifier.send(buildFailedEmail(details));
    cardLog.event("Failed email notification sent");
  } catch (error) {
    cardLog.error(
      `Failed email notification failed: ${getErrorMessage(error)}`,
    );
  }
}

function requiredSecret(
  environment: NodeJS.ProcessEnv,
  environmentVariable: string,
): string {
  const value = environment[environmentVariable];

  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `Invalid environment:\n${environmentVariable}: ${environmentVariable} is required when email notifications are enabled`,
    );
  }

  return value;
}

export function createEmailNotifier(
  config: EmailNotificationConfig | undefined,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): EmailNotifier | undefined {
  if (config === undefined || !config.enabled) {
    return undefined;
  }

  if (config.recipients === undefined) {
    throw new Error(
      "Invalid email notification configuration:\nnotifications.email.recipients: Required when email notifications are enabled",
    );
  }

  if (config.from === undefined) {
    throw new Error(
      "Invalid email notification configuration:\nnotifications.email.from: Required when email notifications are enabled",
    );
  }

  if (config.smtp === undefined) {
    throw new Error(
      "Invalid email notification configuration:\nnotifications.email.smtp: Required when email notifications are enabled",
    );
  }

  return new SmtpEmailNotifier({
    recipients: config.recipients,
    from: config.from,
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    username: requiredSecret(environment, config.smtp.usernameEnv),
    password: requiredSecret(environment, config.smtp.passwordEnv),
    timeoutMilliseconds: config.smtp.timeoutSeconds * 1000,
    ...(signal === undefined ? {} : { signal }),
  });
}
