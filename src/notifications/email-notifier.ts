import type { Logger } from "../logging/logger.js";
import type { TrelloCard } from "../trello/trello-client.js";

import type {
  EmailNotificationConfig,
  ProjectConfig,
} from "../config/config.js";
import type { RefinementResult } from "../refinement/refinement-result.js";
import { SmtpEmailNotifier } from "./smtp-email-notifier.js";

export interface EmailMessage {
  subject: string;
  text: string;
}

export type EmailNotificationEvent =
  | "humanReview"
  | "failed"
  | "refinementComplete"
  | "done"
  | "attentionRequired";

export interface EmailNotifier {
  send(message: EmailMessage): Promise<void>;
  isEventEnabled?(event: EmailNotificationEvent): boolean;
}

export interface HumanReviewNotificationDetails {
  project: ProjectConfig;
  card: TrelloCard;
  pullRequestUrl: string;
  commitSha: string;
  reviewResult: string;
  remediationResult: string;
  elapsedWorkflowTime?: string;
  publicationContext: string;
}

export interface FailedNotificationDetails {
  project: ProjectConfig;
  card: Pick<TrelloCard, "name" | "url">;
  category: string;
  reason: string;
}

export interface AttentionRequiredNotificationDetails {
  project: ProjectConfig;
  category: string;
  reason: string;
  cardIds?: string[];
  sessionLogPaths?: string[];
  handlingOutcome?: string;
}

export interface RefinementCompletionNotificationDetails {
  project: ProjectConfig;
  card: Pick<TrelloCard, "name" | "url">;
  result: RefinementResult;
}

export interface CompletionNotificationDetails {
  project: ProjectConfig;
  card: Pick<TrelloCard, "name" | "url">;
  pullRequestUrl: string;
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
      ...(details.elapsedWorkflowTime === undefined
        ? []
        : [`Elapsed workflow time: ${details.elapsedWorkflowTime}`]),
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

export function buildAttentionRequiredEmail(
  details: AttentionRequiredNotificationDetails,
): EmailMessage {
  return {
    subject: `[Agent Orchestrator] Attention Required: ${subjectPart(details.project.id)}`,
    text: [
      "Event: Attention Required",
      `Project: ${details.project.id}`,
      `Failure category: ${details.category}`,
      `Failure reason: ${details.reason}`,
      ...(details.cardIds === undefined || details.cardIds.length === 0
        ? []
        : [`Affected card IDs: ${details.cardIds.join(", ")}`]),
      ...(details.sessionLogPaths === undefined ||
      details.sessionLogPaths.length === 0
        ? []
        : [
            "Session logs:",
            ...details.sessionLogPaths.map(
              (sessionLogPath) => `- ${sessionLogPath}`,
            ),
          ]),
      ...(details.handlingOutcome === undefined
        ? []
        : [`Failure handling: ${details.handlingOutcome}`]),
      "",
      "Project processing cannot safely continue until the failure is resolved.",
    ].join("\n"),
  };
}

export function buildRefinementCompletionEmail(
  details: RefinementCompletionNotificationDetails,
): EmailMessage {
  return {
    subject: `[Agent Orchestrator] Refinement Complete: ${subjectPart(details.project.id)} / ${subjectPart(details.card.name)}`,
    text: [
      "Event: Refinement Complete",
      `Project: ${details.project.id}`,
      `Card: ${details.card.name}`,
      `Trello card URL: ${details.card.url}`,
      `Classification: ${details.result.type}`,
      `Refined task title: ${details.result.title}`,
      "Refined task description:",
      details.result.description,
    ].join("\n"),
  };
}

export function buildCompletionEmail(
  details: CompletionNotificationDetails,
): EmailMessage {
  return {
    subject: `[Agent Orchestrator] Completed: ${subjectPart(details.project.id)} / ${subjectPart(details.card.name)}`,
    text: [
      "Event: Completed",
      `Project: ${details.project.id}`,
      `Card: ${details.card.name}`,
      `Trello card URL: ${details.card.url}`,
      `Pull request URL: ${details.pullRequestUrl}`,
    ].join("\n"),
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEventEnabled(
  notifier: EmailNotifier,
  event: EmailNotificationEvent,
): boolean {
  return notifier.isEventEnabled?.(event) ?? true;
}

export async function notifyHumanReview(
  notifier: EmailNotifier | undefined,
  details: HumanReviewNotificationDetails,
  cardLog: Logger,
): Promise<void> {
  if (notifier === undefined || !isEventEnabled(notifier, "humanReview")) {
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
  if (notifier === undefined || !isEventEnabled(notifier, "failed")) {
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

export async function notifyAttentionRequired(
  notifier: EmailNotifier | undefined,
  details: AttentionRequiredNotificationDetails,
  projectLog: Logger,
): Promise<void> {
  if (
    notifier === undefined ||
    !isEventEnabled(notifier, "attentionRequired")
  ) {
    return;
  }

  try {
    await notifier.send(buildAttentionRequiredEmail(details));
    projectLog.event("Attention-required email notification sent");
  } catch (error) {
    projectLog.error(
      `Attention-required email notification failed: ${getErrorMessage(error)}`,
    );
  }
}

export async function notifyRefinementCompletion(
  notifier: EmailNotifier | undefined,
  details: RefinementCompletionNotificationDetails,
  cardLog: Logger,
): Promise<void> {
  if (
    notifier === undefined ||
    !isEventEnabled(notifier, "refinementComplete")
  ) {
    return;
  }

  try {
    await notifier.send(buildRefinementCompletionEmail(details));
    cardLog.event("Refinement completion email notification sent");
  } catch (error) {
    cardLog.error(
      `Refinement completion email notification failed: ${getErrorMessage(error)}`,
    );
  }
}

export async function notifyCompletion(
  notifier: EmailNotifier | undefined,
  details: CompletionNotificationDetails,
  cardLog: Logger,
): Promise<void> {
  if (notifier === undefined || !isEventEnabled(notifier, "done")) {
    return;
  }

  try {
    await notifier.send(buildCompletionEmail(details));
    cardLog.event("Completion email notification sent");
  } catch (error) {
    cardLog.error(
      `Completion email notification failed: ${getErrorMessage(error)}`,
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
    ...(config.events === undefined ? {} : { events: config.events }),
    ...(signal === undefined ? {} : { signal }),
  });
}
