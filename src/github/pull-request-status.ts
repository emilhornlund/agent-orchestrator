export const AGENT_ORCHESTRATOR_STATUS_START =
  "<!-- agent-orchestrator-status:start -->";
export const AGENT_ORCHESTRATOR_STATUS_END =
  "<!-- agent-orchestrator-status:end -->";

export type ManagedPullRequestStatus =
  | "rebasing"
  | "resolving-conflicts"
  | "validating"
  | "updating-remote"
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
    case "rebasing":
      return `Agent Orchestrator status: rebasing onto the latest configured default branch (${defaultBranch}).`;
    case "resolving-conflicts":
      return "Agent Orchestrator status: resolving merge conflicts; human attention may be required if automatic remediation cannot complete.";
    case "validating":
      return "Agent Orchestrator status: running repository validation before updating the task branch.";
    case "updating-remote":
      return "Agent Orchestrator status: updating the remote task branch.";
    case "failed":
      return "Agent Orchestrator status: branch maintenance failed. Human attention is required; do not assume the branch is maintained.";
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
    return body.length === 0 ? replacement : `${body}\n\n${replacement}`;
  }

  return (
    body.slice(0, managedSection.start) +
    replacement +
    body.slice(managedSection.end)
  );
}
