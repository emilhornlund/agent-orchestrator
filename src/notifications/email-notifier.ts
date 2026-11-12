import type { Logger } from "../logging/logger.js";
import { logger } from "../logging/logger.js";
import { createHash } from "node:crypto";
import { workflowMutationIdentity } from "../task-session/workflow-mutation.js";
import {
  refinementMutationSnapshotKey,
  refinementMutationSnapshotSchema,
} from "../refinement/refinement-mutation-snapshot.js";
import type { TrelloCard } from "../trello/trello-client.js";

import type { EmailNotificationConfig, ProjectConfig } from "../config/config.js";
import type { RefinementResult } from "../refinement/refinement-result.js";
import { presentExternalDiagnostic } from "../security/bounded-diagnostic.js";
import { SmtpEmailNotifier } from "./smtp-email-notifier.js";
import {
  NotificationOutbox,
  NotificationPreparationError,
  createNotificationObligation,
  notificationObligationSchema,
  type NotificationTrigger,
} from "./notification-outbox.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { sanitizeControlledText } from "../security/redact-secrets.js";

export interface EmailMessage {
  messageId?: string;
  subject: string;
  text: string;
}

export type EmailNotificationEvent =
  "humanReview" | "failed" | "refinementComplete" | "done" | "attentionRequired";

export interface EmailNotifier {
  readonly deliveryTarget?: string;
  send(message: EmailMessage): Promise<void | EmailDeliveryReceipt>;
  /** Authoritative provider evidence only; absence is ambiguous, not rejection. */
  lookupDelivery?(messageId: string): Promise<"confirmed" | "known-not-delivered" | "ambiguous">;
  isEventEnabled?(event: EmailNotificationEvent): boolean;
}

export interface EmailDeliveryReceipt {
  providerId: string;
  partial: boolean;
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
  actualDraft?: boolean;
  outstandingIssues?: string[];
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
  elapsedWorkflowTime?: string;
}

export interface CompletionNotificationDetails {
  project: ProjectConfig;
  card: Pick<TrelloCard, "name" | "url">;
  pullRequestUrl: string;
}

function subjectPart(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function buildHumanReviewEmail(details: HumanReviewNotificationDetails): EmailMessage {
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
      `Actual draft status: ${details.actualDraft === undefined ? "not observed" : details.actualDraft}`,
      `Outstanding issues: ${details.outstandingIssues === undefined ? "See review and remediation evidence below; no complete issue assessment recorded" : details.outstandingIssues.join("; ") || "None recorded in the available publication evidence"}`,
      `Review result: ${details.reviewResult}`,
      `Remediation result: ${details.remediationResult}`,
      ...(details.elapsedWorkflowTime === undefined
        ? []
        : [`Elapsed workflow time: ${details.elapsedWorkflowTime}`]),
    ].join("\n"),
  };
}

/** Only explicit successful/not-required status tokens establish no issue for
 * these routes; other outcomes must remain disclosed. */
export function publicationNotificationIssues(review: string, remediation: string): string[] {
  return [review, remediation].filter((value) => !["Passed", "Not required"].includes(value));
}

export function buildFailedEmail(details: FailedNotificationDetails): EmailMessage {
  return {
    subject: `[Agent Orchestrator] Failed: ${subjectPart(details.project.id)} / ${subjectPart(details.card.name)}`,
    text: [
      "Event: Failed",
      `Project: ${details.project.id}`,
      `Card: ${details.card.name}`,
      `Trello card URL: ${details.card.url}`,
      `Failure category: ${presentExternalDiagnostic(details.category)}`,
      `Failure reason: ${presentExternalDiagnostic(details.reason)}`,
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
      `Failure category: ${presentExternalDiagnostic(details.category)}`,
      `Failure reason: ${presentExternalDiagnostic(details.reason)}`,
      ...(details.cardIds === undefined || details.cardIds.length === 0
        ? []
        : [`Affected card IDs: ${details.cardIds.join(", ")}`]),
      ...(details.cardIds ?? []).map(
        (id) => `Trello card: https://trello.com/c/${encodeURIComponent(id)}`,
      ),
      ...(details.sessionLogPaths === undefined || details.sessionLogPaths.length === 0
        ? []
        : [
            "Session logs:",
            ...details.sessionLogPaths.map((sessionLogPath) => `- ${sessionLogPath}`),
          ]),
      ...(details.handlingOutcome === undefined
        ? []
        : [`Failure handling: ${presentExternalDiagnostic(details.handlingOutcome)}`]),
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
      ...(details.elapsedWorkflowTime === undefined
        ? []
        : [`Elapsed workflow time: ${details.elapsedWorkflowTime}`]),
    ].join("\n"),
  };
}

export function buildCompletionEmail(details: CompletionNotificationDetails): EmailMessage {
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
  return sanitizeControlledText(error instanceof Error ? error.message : String(error));
}

export function enqueueNotification(
  notifier: EmailNotifier | undefined,
  projectId: string,
  event: EmailNotificationEvent,
  identity: string,
  message: EmailMessage,
  trigger?: NotificationTrigger,
): NotificationOutbox | undefined {
  if (!notifier || !isEventEnabled(notifier, event)) return undefined;
  try {
    const outbox = NotificationOutbox.current(projectId);
    if (outbox) {
      const authority = ProjectRunAuthority.current(projectId);
      const attempt = authority?.store.attemptId ?? "project";
      const eventKey = `${projectId}:${attempt}:${event}:${identity}`;
      if (!authority) {
        outbox.enqueue(eventKey, message, event, notifier.deliveryTarget, trigger);
        return outbox;
      }
      if (trigger) {
        const run = authority.store.assertCurrentLease(authority.ownerGeneration);
        const request = {
          route: "trello-move",
          args: {
            cardId: trigger.cardId,
            listId: trigger.listId,
            options: trigger.dueComplete === undefined ? {} : { dueComplete: trigger.dueComplete },
          },
        };
        const digest = (value: unknown) =>
          createHash("sha256")
            .update(sanitizeControlledText(JSON.stringify(value)))
            .digest("hex");
        const snapshot =
          event === "refinementComplete"
            ? refinementMutationSnapshotSchema.parse(
                run.compatibility[refinementMutationSnapshotKey],
              )
            : undefined;
        trigger = {
          ...trigger,
          binding: {
            attemptId: run.attemptId,
            operationId: workflowMutationIdentity(
              run,
              "trello-move",
              `trello:${trigger.boardId}:${trigger.cardId}`,
              request,
            ),
            payloadId: `sha256:${digest(request)}`,
            executionGeneration: run.operation.generation,
            ...(snapshot ? { refinementHash: digest(snapshot.intended) } : {}),
          },
        };
      }
      const candidate = createNotificationObligation(
        projectId,
        eventKey,
        message,
        event,
        notifier.deliveryTarget,
        trigger,
      );
      const key = `notification-event-${candidate.id}`;
      const durable =
        authority.read(key, notificationObligationSchema.parse) ??
        authority.mutate(
          key,
          candidate,
          (value) => ({
            value,
            result: notificationObligationSchema.parse(value),
          }),
          notificationObligationSchema.parse,
        );
      try {
        outbox.materialize(durable);
      } catch {
        // The immutable event obligation is already durable under RunStore.
        // Delivery-file failure is not a workflow completion/release failure.
        authority.assertHeld();
        logger
          .child({ projectId })
          .warn(
            "Notification delivery storage unavailable; authoritative event obligation retained for delivery recovery",
          );
      }
    } else if (ProjectRunAuthority.hasProjectLeaseScope()) {
      throw new Error("Production notification requires pinned durable outbox scope");
    }
    return outbox;
  } catch (cause) {
    throw new NotificationPreparationError(
      "Notification event preparation failed; preserve workflow for retry",
      { cause },
    );
  }
}

export function prepareAttentionNotification(
  notifier: EmailNotifier | undefined,
  details: AttentionRequiredNotificationDetails,
): void {
  enqueueNotification(
    notifier,
    details.project.id,
    "attentionRequired",
    `${details.category}:${details.reason}:${details.cardIds?.join(",") ?? ""}`,
    buildAttentionRequiredEmail(details),
  );
}

async function deliverEvent(
  notifier: EmailNotifier,
  projectId: string,
  event: EmailNotificationEvent,
  identity: string,
  message: EmailMessage,
  log: Logger,
): Promise<void> {
  const outbox = enqueueNotification(notifier, projectId, event, identity, message);
  if (outbox) outbox.start(notifier, (diagnostic) => log.warn(diagnostic));
  else await notifier.send(message); // Explicitly unowned utility compatibility.
}

function isEventEnabled(notifier: EmailNotifier, event: EmailNotificationEvent): boolean {
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
    await deliverEvent(
      notifier,
      details.project.id,
      "humanReview",
      details.commitSha,
      buildHumanReviewEmail(details),
      cardLog,
    );
    cardLog.event("Human Review email notification processed");
  } catch (error) {
    if (error instanceof NotificationPreparationError) throw error;
    cardLog.error(`Human Review email notification failed: ${getErrorMessage(error)}`);
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
    await deliverEvent(
      notifier,
      details.project.id,
      "failed",
      details.card.url,
      buildFailedEmail(details),
      cardLog,
    );
    cardLog.event("Failed email notification processed");
  } catch (error) {
    if (error instanceof NotificationPreparationError) throw error;
    cardLog.error(`Failed email notification failed: ${getErrorMessage(error)}`);
  }
}

export async function notifyAttentionRequired(
  notifier: EmailNotifier | undefined,
  details: AttentionRequiredNotificationDetails,
  projectLog: Logger,
): Promise<void> {
  if (notifier === undefined || !isEventEnabled(notifier, "attentionRequired")) {
    return;
  }

  try {
    await deliverEvent(
      notifier,
      details.project.id,
      "attentionRequired",
      `${details.category}:${details.reason}:${details.cardIds?.join(",") ?? ""}`,
      buildAttentionRequiredEmail(details),
      projectLog,
    );
    projectLog.event("Attention-required email notification processed");
  } catch (error) {
    if (error instanceof NotificationPreparationError) throw error;
    projectLog.error(`Attention-required email notification failed: ${getErrorMessage(error)}`);
  }
}

export async function notifyRefinementCompletion(
  notifier: EmailNotifier | undefined,
  details: RefinementCompletionNotificationDetails,
  cardLog: Logger,
): Promise<void> {
  if (notifier === undefined || !isEventEnabled(notifier, "refinementComplete")) {
    return;
  }

  try {
    await deliverEvent(
      notifier,
      details.project.id,
      "refinementComplete",
      details.card.url,
      buildRefinementCompletionEmail(details),
      cardLog,
    );
    cardLog.event("Refinement completion email notification processed");
  } catch (error) {
    if (error instanceof NotificationPreparationError) throw error;
    cardLog.error(`Refinement completion email notification failed: ${getErrorMessage(error)}`);
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
    await deliverEvent(
      notifier,
      details.project.id,
      "done",
      details.pullRequestUrl,
      buildCompletionEmail(details),
      cardLog,
    );
    cardLog.event("Completion email notification processed");
  } catch (error) {
    if (error instanceof NotificationPreparationError) throw error;
    cardLog.error(`Completion email notification failed: ${getErrorMessage(error)}`);
  }
}

function requiredSecret(environment: NodeJS.ProcessEnv, environmentVariable: string): string {
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
