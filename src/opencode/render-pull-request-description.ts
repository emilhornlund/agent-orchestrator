import {
  AGENT_ORCHESTRATOR_STATUS_END,
  AGENT_ORCHESTRATOR_STATUS_START,
} from "../github/pull-request-status.js";
import { buildPullRequestAttributionFooter } from "../github/pull-request-attribution.js";
import type { TrelloCard } from "../trello/trello-client.js";

import type { PullRequestDescription } from "./pull-request-description.js";

export type PullRequestTaskContext = Pick<TrelloCard, "name" | "url">;

function normalizeGeneratedText(
  value: string,
  attributionFooter: string,
): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replaceAll(AGENT_ORCHESTRATOR_STATUS_START, "[status start marker]")
    .replaceAll(AGENT_ORCHESTRATOR_STATUS_END, "[status end marker]")
    .replaceAll(attributionFooter, "[application footer text]")
    .replace(
      /^((?:(?:>\s*)|(?:(?:[-+*]|\d+[.)])\s+))*)(#{1,6})(?=\s)/,
      (_match: string, prefix: string, hashes: string) =>
        `${prefix}\\${hashes}`,
    );
}

function normalizeTaskName(value: string, attributionFooter: string): string {
  const name = value
    .replace(/\s+/g, " ")
    .trim()
    .replaceAll(AGENT_ORCHESTRATOR_STATUS_START, "[status start marker]")
    .replaceAll(AGENT_ORCHESTRATOR_STATUS_END, "[status end marker]")
    .replaceAll(attributionFooter, "[application footer text]");

  return name.length > 0 ? name : "Trello card";
}

function renderPullRequestDescriptionBody(
  description: PullRequestDescription,
  task: PullRequestTaskContext,
  gitIdentityName: string,
): string {
  const attributionFooter = buildPullRequestAttributionFooter(gitIdentityName);
  const changes = description.changes.map(
    (change) => `- ${normalizeGeneratedText(change, attributionFooter)}`,
  );
  const validation =
    description.validation.length === 0
      ? ["- No validation or test results were provided."]
      : description.validation.map(
          (result) => `- ${normalizeGeneratedText(result, attributionFooter)}`,
        );

  return [
    "## Summary",
    normalizeGeneratedText(description.summary, attributionFooter),
    "",
    "## Changes",
    ...(changes.length > 0 ? changes : ["No changes were provided."]),
    "",
    "## Validation",
    ...validation,
    "",
    "## Task",
    `[Trello card: ${normalizeTaskName(task.name, attributionFooter)}](${task.url})`,
    "",
    attributionFooter,
    "",
    AGENT_ORCHESTRATOR_STATUS_START,
    AGENT_ORCHESTRATOR_STATUS_END,
  ].join("\n");
}

export function renderPullRequestDescription(
  description: PullRequestDescription,
  task: PullRequestTaskContext,
  gitIdentityName: string,
): string;
export function renderPullRequestDescription(
  task: PullRequestTaskContext,
  description: PullRequestDescription,
  gitIdentityName: string,
): string;
export function renderPullRequestDescription(
  first: PullRequestDescription | PullRequestTaskContext,
  second: PullRequestDescription | PullRequestTaskContext,
  gitIdentityName: string,
): string {
  if ("summary" in first) {
    return renderPullRequestDescriptionBody(
      first,
      second as PullRequestTaskContext,
      gitIdentityName,
    );
  }

  return renderPullRequestDescriptionBody(
    second as PullRequestDescription,
    first,
    gitIdentityName,
  );
}
