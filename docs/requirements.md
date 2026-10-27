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
