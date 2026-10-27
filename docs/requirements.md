# Agent Orchestrator — Requirements

## How we work with this document

This is our single shared, human-readable source of truth for how Agent Orchestrator **should** work, not a description of what its code currently does.

- We develop it together through conversation, one small topic and one question at a time.
- We discuss and refine requirements before adding them. ChatGPT commits approved requirements in logical groups to [draft PR #208](https://github.com/emilhornlund/agent-orchestrator/pull/208), without requiring approval for every commit.
- The user does not need to keep a copy, edit GitHub, or review technical specification files.
- Keep requirements concise and understandable. Do not guess or silently change approved decisions.
- Keep the PR in draft until the user explicitly approves the completed document. Evaluate the implementation against these requirements afterward.

**To resume in a new chat:** Say “Continue the Agent Orchestrator requirements from [PR #208](https://github.com/emilhornlund/agent-orchestrator/pull/208).” ChatGPT should read the latest `docs/requirements.md` from the PR as the authoritative record, then continue with the next small question. Do not rely on memories of earlier chats.

## Purpose

Agent Orchestrator automatically turns Trello tasks into implemented, tested, and reviewed GitHub pull requests using AI agents. It manages the end-to-end workflow while allowing humans to control the final outcome.

## Projects and task concurrency

- At least one project must be configured; multiple projects are supported.
- Each project has its own Trello board, Git repository, GitHub repository, and configuration.
- Projects are independent and may process tasks concurrently without interfering with one another.
- Each project processes only one task at a time. The current task must reach a terminal outcome before the project starts another.
- A pull request awaiting `Human Review` is still active and blocks the next task, since later work may depend on its merge.

## Trello lifecycle

- A merged pull request moves its card to `Done`.
- A pull request closed without merging moves its card to `Backlog`. The orchestrator posts a Trello comment explaining the closure and linking to the PR. The task can be revised and explicitly queued again later; closure is not an orchestrator failure.
- An unrecoverable automated failure moves its card to `Failed`, with an explanatory Trello comment and an email notification when configured. The specific conditions for failure will be defined later.
- After a task reaches `Done`, `Failed`, or the cancelled `Backlog` outcome, the project may process its next task.
- Cards in `Failed` are not automatically retried. To try again, the user explicitly returns the card to `Ready for Agent`.

## Task selection

- The orchestrator selects new tasks only from `Ready for Agent`, in top-to-bottom Trello card order.
- The first eligible card takes priority regardless of task type.
- Cards with future start dates are skipped until eligible; skipped or otherwise ineligible cards do not block cards farther down the list.

## Task types and refinement

- Supported task types are `Feature`, `Improvement`, `Bug`, and `Refinement`.
- Refinement improves a card's title, description, and classification without implementing code.
- After successful refinement, the card returns to `Backlog` for human review, and the project may take its next task.

## Refinement context

- Refinement must use the current state of the project's repository, with access to its source code, tests, configuration, documentation, and other relevant files.
- The agent must use repository evidence to judge what needs to be done and how, rather than making assumptions.
- Refined tasks should be actionable and technically grounded, without becoming detailed implementation plans.
- Refinement must not modify source files or other repository content.
- We will agree on a consistent Trello task template separately.

## Unexpected manual Trello moves

- A manual card move must not be mistaken for a successful orchestrator workflow transition.
- If an active card is moved unexpectedly, preserve its execution state and pause further work for that project rather than guessing what happened.
- Moving the card back to its expected list may allow automatic resumption, but only after the orchestrator verifies it is safe.
- Other projects must remain unaffected. We may refine the precise recovery rules later.

## Trello attachments

- Agents must have access to all supported attachments on their Trello cards during refinement and implementation, including relevant images, documents, and logs.
- Current attachments must be available when work starts or resumes.
- Store downloaded attachment context separately from the Git repository.
- Attachment access failures must be reported rather than silently ignored.

## Implementation planning

- Before modifying code, the implementation agent analyzes the task, attachments, and current repository state, then prepares an implementation plan.
- An independent AI agent reviews the plan for correctness, completeness, and alignment with the task.
- Implementation starts only after the plan is approved. No routine human plan approval is required.
- If the plan cannot be approved, code changes must not begin.

## Implementation boundaries

- Implementation takes place in an isolated Git worktree on a task-specific branch, never in the original source checkout.
- The agent may modify source code, tests, configuration, and documentation as necessary for the task.
- Changes must follow the approved plan and repository-specific instructions, without unrelated modifications.

## Primary delivery requirement

**The highest-priority goal of every implementation task is to produce a GitHub pull request.**

- Every implementation task must result in a pull request, even when validation, tests, or independent AI review have unresolved failures.
- The orchestrator attempts to resolve problems automatically within configured limits, but those limits must not create an endless loop or prevent delivery.
- Any unresolved failures or review findings must be disclosed clearly in the pull request; an incomplete implementation must never be represented as validated or ready to merge.
- A failure to produce a pull request is exceptional and must have a genuine safety or external-operation reason, such as unavailable Git/GitHub services or a repository state that cannot be published safely.
- Producing a pull request is not the same as approving it for merge. The detailed review, validation, and publication policies will be agreed separately.
