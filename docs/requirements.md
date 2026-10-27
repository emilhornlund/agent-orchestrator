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

## Validation, review, and PR readiness

- The orchestrator runs configured validation commands itself, rather than relying on an agent's claim that they passed.
- Validation failures and independent AI review findings have separate configurable remediation limits. Within those limits, the implementation agent may address findings and the relevant checks are rerun.
- Exhausting either limit must not prevent PR delivery.
- When required validation and review pass, the orchestrator creates a normal pull request. If tests, validation, or independent AI review still have unresolved problems, it creates a draft pull request and clearly describes those problems.
- Both normal and draft pull requests move the Trello card to `Human Review`. If email notifications are configured, a PR notification is sent, explicitly identifying draft PRs and their outstanding issues.
- A draft PR may be marked ready for review when its outstanding issues have been resolved and verified.
- The orchestrator never automatically merges pull requests; merging or closing is a human decision. A project cannot start its next task while its PR remains open.

## Human review and requested changes

- GitHub reviews requesting changes are handled automatically; no manual Trello action is necessary.
- The orchestrator collects all outstanding actionable feedback, including review summaries, inline comments, and general PR comments, retaining file and line context when available.
- It moves the card from `Human Review` to `Working`, addresses feedback on the existing task branch, and updates the same pull request rather than creating a replacement.
- It reruns validation and independent AI review, then returns the card to `Human Review` with clear information about any remaining issues.
- Replies to addressed comments are posted only after the associated changes have been published and verified.
- Feedback arriving during remediation must not be lost. After the current cycle, the orchestrator checks again and handles new or still-unresolved requests without unnecessarily repeating completed work.
- Human review cycles are unlimited: new requests for changes can be submitted as often as needed. Configurable limits apply only to internal automated validation, review, and correction attempts within a cycle, never to the number of human-requested-change cycles.
- The task remains active until its pull request is merged or closed.

## GitHub CI

- After a pull request is created or updated, the orchestrator waits for all expected GitHub CI checks and evaluates their results.
- It automatically attempts to fix failed checks within a separately configurable correction limit, publishing fixes to the same PR and rerunning checks.
- Unresolved CI failures leave the PR as a draft with clear diagnostics, not an indefinitely blocked delivery.
- Checks that never start or finish must not leave the workflow waiting indefinitely; the uncertainty must be reported rather than treated as a pass.

## Automatic PR maintenance

- While a PR awaits human review, the orchestrator automatically detects when its branch needs updating or has merge conflicts with the target branch.
- It attempts to rebase onto the latest target branch and uses an AI agent to resolve conflicts when needed, preserving existing work.
- After changes, it runs validation, independent review, and CI again and updates the same PR.
- The orchestrator must not force-push, discard work, or create replacement PRs to bypass conflicts.
- Problems it cannot safely resolve must be reported clearly with enough state preserved for recovery.

## Restart and crash recovery

- After a crash, shutdown, or container restart, the orchestrator must automatically resume interrupted work from its last verified state whenever safe.
- Preserve worktrees, code changes, AI sessions, task ownership, and workflow progress; never silently start over or duplicate commits, pull requests, Trello actions, or other side effects.
- If the previous state cannot be established safely, preserve all evidence, notify the operator, and block new tasks in the affected project until the situation is resolved.
- Recovery problems in one project must not stop unrelated projects.

## External service interruptions

- Temporary unavailability, timeouts, and transient failures in Trello, GitHub, OpenCode, or other dependencies must not permanently fail a task.
- Retry transient failures with sensible bounded attempts and delays. If the dependency remains unavailable, preserve task state and periodically check for safe recovery rather than repeatedly restarting or failing the implementation.
- Resume automatically when the dependency recovers and task state is verified. Never interpret an unavailable service as proof that a resource was deleted or an operation failed.
- Notify the operator when intervention is needed without repeatedly sending duplicate alerts. Unaffected projects continue operating.

## Email notifications

- Email notifications are optional and configurable. Support these four events: refinement completed, PR ready for human review (normal or draft, with outstanding issues), attention required, and task failed.
- Notifications identify the project and task, provide relevant links and useful details, and never expose secrets.
- Email delivery is non-blocking: a notification failure must never undo successful work, change the task's workflow outcome, or prevent a PR from being delivered.
- Failed deliveries are logged and should be retried safely when possible without sending duplicate notifications.

## Logging and diagnostics

- Every task has a traceable execution history, including workflow progress, state transitions, errors, retries, recovery decisions, validation and review results, and task duration.
- Orchestrator logs contain structured workflow events and concise, sanitized diagnostic summaries; raw child-process output must never leak into orchestrator logs.
- OpenCode, Git, validation commands, and other child processes have their stdout, stderr, and streaming output recorded separately, including when they fail.
- Orchestrator diagnostics may refer to the relevant child-process log without reproducing its raw output.
- Logs are organized by project and task and remain available after completion, failure, or restart, subject to retention.
- Log retention is configurable globally, with a default of 30 days. Expired logs are cleaned up automatically, but logs belonging to active tasks must never be deleted.

## Execution timeouts

- OpenCode sessions, validation commands, and other long-running operations have configurable timeouts.
- When a timeout is reached, stop the affected process and its child processes safely, preserving existing code changes, task state, and logs.
- Attempt bounded recovery when safe. A timeout alone must not unnecessarily prevent eventual PR delivery.

## Git safety and cleanup

- Never modify the configured original source checkout. All agent changes belong in isolated task worktrees and branches.
- Never force-push, overwrite unrelated remote changes, or automatically discard uncommitted work.
- Never delete branches or worktrees without verifying that they belong to the task and are safe to remove.
- Recovery must not create duplicate commits or pull requests.
- After a PR is merged, automatically clean up the owned task branch and worktree when safe. If cleanup cannot be verified as safe, preserve them and report the problem.

## Pull request descriptions and working status

- The orchestrator generates a useful PR description from the actual implementation, covering the purpose and summary, significant changes, validation and test results (including failures), outstanding issues, and a link to the Trello task.
- The description is refreshed after significant changes, including human-review remediation, CI repairs, and rebasing, so it describes the current PR rather than its original implementation only.
- Whenever the agent works on an existing PR, the orchestrator prominently displays a temporary status **at the top of the PR description**, similar to Dependabot's rebase status.
- The status identifies the current activity (such as requested changes, CI repair, rebasing, or validation), is updated as work progresses, and is cleared when the activity finishes. It must not obscure or overwrite the underlying PR description.
