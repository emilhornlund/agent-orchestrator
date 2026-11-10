import type { FeedbackLedgerEntry } from "../task-session/feedback-ledger.js";
import type { TaskPlan } from "../task-session/task-plan.js";
import type { TrelloCard } from "../trello/trello-client.js";
import { taskSessionRepositoryGuidance } from "./task-session-prompt-guidance.js";

export function buildTaskSessionFeedbackVerificationPrompt(input: {
  projectId: string;
  card: TrelloCard;
  approvedPlan?: TaskPlan;
  currentHeadSha: string;
  contentIdentity: string;
  currentDiff: string;
  actionableFeedback: readonly FeedbackLedgerEntry[];
  qualityEvidence: unknown;
}): string {
  if (
    input.approvedPlan !== undefined &&
    (input.approvedPlan.projectId !== input.projectId ||
      input.approvedPlan.cardId !== input.card.id)
  ) {
    throw new Error("Feedback verification plan does not match task identity");
  }
  return [
    "Independently verify each actionable human PR feedback item against the current implementation.",
    "You are read-only. Do not modify files, run Git/GitHub commands, reply to comments, or resolve threads.",
    `Task identity: ${JSON.stringify({ projectId: input.projectId, cardId: input.card.id })}`,
    `Current PR head: ${input.currentHeadSha}`,
    `Reviewed source identity: ${input.contentIdentity}`,
    `Task title: ${JSON.stringify(input.card.name)}`,
    "Original task:",
    input.card.desc,
    "Advisory task plan:",
    input.approvedPlan === undefined
      ? "No usable plan was available. Assess feedback against the original task, attachments, and repository evidence."
      : JSON.stringify(input.approvedPlan, null, 2),
    "Current diff:",
    input.currentDiff,
    "Previously successful local quality and independent review evidence:",
    JSON.stringify(input.qualityEvidence, null, 2),
    "Feedback items requiring one disposition each:",
    JSON.stringify(input.actionableFeedback, null, 2),
    ...taskSessionRepositoryGuidance,
    "Return only JSON matching {version:1, projectId, cardId, headSha, contentIdentity, dispositions:[...]}. Each disposition must contain feedbackId and either status=verified-fixed with nonempty supporting evidence paths/tests, status=unresolved for an established remaining request, or status=uncertain when available evidence cannot establish fulfillment. Unresolved and uncertain dispositions require a concrete reason. Failed/pending checks are context, not a veto on evaluating available corrections. Never claim fulfillment solely from the implementation agent's declaration. Do not omit or invent an item.",
  ].join("\n");
}
