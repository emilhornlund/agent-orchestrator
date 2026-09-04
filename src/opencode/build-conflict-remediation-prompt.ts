import type { PreparedConflictHandoff } from "../orchestrator/prepared-conflict-state.js";
import type { TrelloCard } from "../trello/trello-client.js";

export function buildConflictRemediationPrompt(
  card: TrelloCard,
  handoff: PreparedConflictHandoff,
  validationCommand?: string,
): string {
  const rebaseTarget = `origin/${handoff.defaultBranch}`;

  return [
    "Resolve the active Git rebase conflicts for the existing task branch.",
    "",
    `Task: ${card.name}`,
    "Task description:",
    card.desc.trim() || "(No task description was provided.)",
    "",
    `Current task branch: ${handoff.taskBranch}`,
    `Updated base branch: ${handoff.defaultBranch}`,
    `Rebase target: ${rebaseTarget}`,
    `Rebase target commit: ${handoff.rebase.onto}`,
    ...(handoff.rebase.currentStep === undefined ||
    handoff.rebase.totalSteps === undefined
      ? []
      : [
          `Rebase progress at handoff: commit ${handoff.rebase.currentStep} of ${handoff.rebase.totalSteps}`,
        ]),
    "Git rebase status: a rebase is currently in progress.",
    `Conflicted files:\n${handoff.conflictedPaths.map((file) => `- ${file}`).join("\n")}`,
    "",
    "Inspect the current Git and repository state before editing.",
    "Resolve only the active rebase conflicts. Preserve the intended task changes and compatible changes from the updated base branch; do not do unrelated implementation work.",
    "Stage every resolved file, then continue the rebase until it completes.",
    "A rebase can stop for conflicts more than once when multiple commits are being replayed. Re-inspect and resolve each stop, stage its resolutions, and continue until no rebase remains active.",
    ...(validationCommand
      ? [
          `Run the configured repository validation command: \`${validationCommand}\` before finishing.`,
        ]
      : [
          "Run the repository's appropriate validation checks before finishing.",
        ]),
    "Leave the worktree with a completed rebase and no unresolved or unstaged changes.",
    "Do not create unrelated commits.",
    "Do not push anything.",
    "Do not open or modify pull requests.",
  ].join("\n");
}
