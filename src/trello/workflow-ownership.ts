import { z } from "zod";

import type { ProjectConfig } from "../config/config.js";
import type { TrelloCard } from "./trello-client.js";

export const workflowOwnershipSchema = z.strictObject({
  version: z.literal(1),
  owner: z.literal("agent-orchestrator"),
  projectId: z.string().min(1),
  cardId: z.string().min(1),
  workflow: z.enum(["implementation", "refinement"]),
});

export type WorkflowKind = z.infer<typeof workflowOwnershipSchema>["workflow"];
export type WorkflowOwnership = z.infer<typeof workflowOwnershipSchema>;

export type WorkflowOwnershipValidation =
  | {
      status: "missing";
      reason: string;
    }
  | {
      status: "owned";
      ownership: WorkflowOwnership;
    }
  | {
      status: "invalid";
      reason: string;
      raw?: string;
    };

export function createWorkflowOwnership(
  project: ProjectConfig,
  card: TrelloCard,
  workflow: WorkflowKind,
): WorkflowOwnership {
  return {
    version: 1,
    owner: "agent-orchestrator",
    projectId: project.id,
    cardId: card.id,
    workflow,
  };
}

export function serializeWorkflowOwnership(
  ownership: WorkflowOwnership,
): string {
  return JSON.stringify(ownership);
}

export function validateWorkflowOwnership(
  card: TrelloCard,
  project: ProjectConfig,
  expectedWorkflow?: WorkflowKind,
): WorkflowOwnershipValidation {
  const markerValues = card.workflowOwnershipValues;

  if (markerValues !== undefined && markerValues.length !== 1) {
    return {
      status: "invalid",
      reason: "multiple ownership marker values were returned",
    };
  }

  if (
    markerValues !== undefined &&
    card.workflowOwnership !== undefined &&
    markerValues[0] !== card.workflowOwnership
  ) {
    return {
      status: "invalid",
      reason: "conflicting ownership marker values were returned",
    };
  }

  const raw = markerValues?.[0] ?? card.workflowOwnership;

  if (raw === undefined) {
    return {
      status: "missing",
      reason: "no ownership marker was found",
    };
  }

  if (raw.trim().length === 0) {
    return {
      status: "invalid",
      reason: "the ownership marker is empty",
      raw,
    };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      status: "invalid",
      reason: `the ownership marker is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      raw,
    };
  }

  const result = workflowOwnershipSchema.safeParse(parsed);

  if (!result.success) {
    return {
      status: "invalid",
      reason: "the ownership marker has an invalid shape or version",
      raw,
    };
  }

  const ownership = result.data;

  if (ownership.projectId !== project.id) {
    return {
      status: "invalid",
      reason: `the ownership marker belongs to project "${ownership.projectId}" instead of "${project.id}"`,
      raw,
    };
  }

  if (ownership.cardId !== card.id) {
    return {
      status: "invalid",
      reason: `the ownership marker belongs to card "${ownership.cardId}" instead of "${card.id}"`,
      raw,
    };
  }

  if (
    expectedWorkflow !== undefined &&
    ownership.workflow !== expectedWorkflow
  ) {
    return {
      status: "invalid",
      reason: `the ownership marker identifies a ${ownership.workflow} workflow, not ${expectedWorkflow}`,
      raw,
    };
  }

  return {
    status: "owned",
    ownership,
  };
}

export function hasWorkflowOwnershipMarker(card: TrelloCard): boolean {
  return (
    card.workflowOwnership !== undefined ||
    card.workflowOwnershipValues !== undefined
  );
}
