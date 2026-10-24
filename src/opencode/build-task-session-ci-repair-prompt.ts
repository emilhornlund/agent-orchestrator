import type { FailedCheckDiagnostic } from "../github/github-client.js";
import type { TaskPlan } from "../task-session/task-plan.js";
import type { TrelloCard } from "../trello/trello-client.js";
import { taskSessionRepositoryGuidance } from "./task-session-prompt-guidance.js";

export function buildTaskSessionCiRepairPrompt(input: {
  projectId: string;
  card: TrelloCard;
  approvedPlan: TaskPlan;
  headSha: string;
  attempt: number;
  maxAttempts: number;
  diagnostics: readonly FailedCheckDiagnostic[];
}): string {
  if (
    input.approvedPlan.projectId !== input.projectId ||
    input.approvedPlan.cardId !== input.card.id
  ) {
    throw new Error("CI repair plan does not match task identity");
  }
  if (
    input.diagnostics.length === 0 ||
    input.diagnostics.some((item) => item.headSha !== input.headSha)
  ) {
    throw new Error(
      "CI repair requires diagnostics for the exact failed PR head",
    );
  }
  return [
    "Repair the required GitHub CI failures on the current PR head in the existing primary task session.",
    `Task: ${JSON.stringify({ projectId: input.projectId, cardId: input.card.id, title: input.card.name })}`,
    `Original task description: ${input.card.desc}`,
    `Current PR head: ${input.headSha}`,
    `Bounded CI repair attempt ${input.attempt} of ${input.maxAttempts}.`,
    "Approved plan:",
    JSON.stringify(input.approvedPlan, null, 2),
    "Failed check diagnostics (the orchestrator verified these refer to this exact head):",
    JSON.stringify(input.diagnostics, null, 2),
    ...taskSessionRepositoryGuidance,
    "Fix only the failures while preserving the approved task scope. Leave changes in the worktree for orchestrator-owned validation, coverage, and independent review.",
    "Do not run Git commands or invoke GitHub tools. Do not commit, change branches, push, or create another pull request; the orchestrator owns publication and reuses the existing PR.",
  ].join("\n");
}
