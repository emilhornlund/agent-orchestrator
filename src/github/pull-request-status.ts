export const AGENT_ORCHESTRATOR_STATUS_START =
  "<!-- agent-orchestrator-status:start -->";
export const AGENT_ORCHESTRATOR_STATUS_END =
  "<!-- agent-orchestrator-status:end -->";

export type ManagedPullRequestStatus =
  | "rebasing"
  | "synchronizing-target"
  | "repairing-ci"
  | "validating-pr-changes"
  | "automation-recovery"
  | "resolving-conflicts"
  | "updating-remote"
  | "addressing-review-feedback"
  | "validating-review-changes"
  | "publishing-review-changes"
  | "publishing-pr-changes"
  | "attention-required"
  | "failed";

export class MalformedManagedPullRequestStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedManagedPullRequestStatusError";
  }
}

function markerPositions(body: string, marker: string): number[] {
  const positions: number[] = [];
  let position = body.indexOf(marker);

  while (position !== -1) {
    positions.push(position);
    position = body.indexOf(marker, position + marker.length);
  }

  return positions;
}

function getManagedSection(
  body: string,
): { start: number; end: number } | null {
  const starts = markerPositions(body, AGENT_ORCHESTRATOR_STATUS_START);
  const ends = markerPositions(body, AGENT_ORCHESTRATOR_STATUS_END);

  if (starts.length === 0 && ends.length === 0) {
    return null;
  }

  if (starts.length !== 1 || ends.length !== 1) {
    throw new MalformedManagedPullRequestStatusError(
      "Pull request description has duplicate or unmatched Agent Orchestrator status markers; edit the description to leave exactly one ordered marker pair or remove all markers",
    );
  }

  const start = starts[0];
  const end = ends[0];

  if (start === undefined || end === undefined || start > end) {
    throw new MalformedManagedPullRequestStatusError(
      "Pull request description has incorrectly ordered Agent Orchestrator status markers; edit the description to put the start marker before the end marker",
    );
  }

  return {
    start,
    end: end + AGENT_ORCHESTRATOR_STATUS_END.length,
  };
}

function statusMessage(
  status: ManagedPullRequestStatus,
  defaultBranch: string,
): string {
  switch (status) {
    case "automation-recovery":
      return "Agent Orchestrator status: PR automation requires recovery. Work and ownership are preserved; do not assume the operation finished.";
    case "synchronizing-target":
      return `Agent Orchestrator status: merging the latest target branch (${defaultBranch}) additively; published commits are preserved.`;
    case "repairing-ci":
      return "Agent Orchestrator status: addressing observed CI failures within the current repair episode.";
    case "validating-pr-changes":
      return "Agent Orchestrator status: running advisory validation and independent review for the current PR changes.";
    case "rebasing":
      return `Agent Orchestrator status: rebasing onto the latest configured default branch (${defaultBranch}).`;
    case "resolving-conflicts":
      return "Agent Orchestrator status: resolving merge conflicts; human attention may be required if automatic remediation cannot complete.";
    case "updating-remote":
      return "Agent Orchestrator status: updating the remote task branch.";
    case "addressing-review-feedback":
      return "Agent Orchestrator status: addressing requested review feedback; remediation is in progress and the review is not yet resolved.";
    case "validating-review-changes":
      return "Agent Orchestrator status: validating requested review changes; remediation is in progress and the review is not yet resolved.";
    case "publishing-review-changes":
      return "Agent Orchestrator status: publishing requested review changes; remediation is in progress and the review is not yet resolved.";
    case "publishing-pr-changes":
      return "Agent Orchestrator status: publishing updates to this existing pull request; outstanding issues remain disclosed.";
    case "attention-required":
      return "Agent Orchestrator status: requested review changes remain unresolved. Human attention is required; do not assume the review was resolved.";
    case "failed":
      return "Agent Orchestrator status: branch maintenance failed or requested-change remediation failed. Human attention is required; do not assume the requested changes were resolved.";
  }
}

function section(message: string): string {
  return [
    AGENT_ORCHESTRATOR_STATUS_START,
    message,
    AGENT_ORCHESTRATOR_STATUS_END,
  ].join("\n");
}

/** Reconciles only the uniquely marked status section of a pull request body. */
export function reconcileManagedPullRequestStatus(
  body: string,
  status: ManagedPullRequestStatus | null,
  defaultBranch: string,
): string {
  const managedSection = getManagedSection(body);

  if (status === null) {
    if (managedSection === null) {
      return body;
    }

    return body.slice(0, managedSection.start) + body.slice(managedSection.end);
  }

  const replacement = section(statusMessage(status, defaultBranch));

  if (managedSection === null) {
    return body.length === 0 ? replacement : `${replacement}\n\n${body}`;
  }
  if (managedSection.start === 0)
    return replacement + body.slice(managedSection.end);
  return `${replacement}\n\n${body.slice(0, managedSection.start)}${body.slice(managedSection.end)}`;
}
