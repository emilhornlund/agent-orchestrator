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

## Commit history

- The initial implementation produces one clean commit with an automatically generated, descriptive message.
- Later review corrections, CI repairs, and other changes are recorded in additional commits on the same task branch. The orchestrator does not amend or rewrite previous commits.
- Humans may choose to squash commits when merging the pull request.

## GitHub authentication

- Support both GitHub App authentication and personal credentials, such as a personal access token.
- Each project independently chooses its GitHub authentication method.
- GitHub App authentication is preferred for its dedicated bot identity and scoped permissions, but is not mandatory.

## Project setup and quality commands

- Each project may optionally configure a setup command, run in its isolated task worktree before refinement or implementation begins. If no command is configured, setup is skipped.
- A successful setup need not be repeated unnecessarily when recovering an interrupted task. Setup output is captured separately from orchestrator logs, and failures are reported and handled safely.
- Each project may optionally and independently configure a validation command and a test coverage command.
- The orchestrator runs each configured command itself and accurately reports its results. An unconfigured command is skipped and must not be represented as having passed.
- Not configuring either quality command must not prevent implementation or pull request delivery.

## AI model configuration

- Each project may independently configure the OpenCode model and reasoning variant for each AI activity, such as refinement, planning, implementation, independent review, remediation, and commit message generation.
- If a model or variant is not specified, let OpenCode use its own configured default rather than imposing an orchestrator-specific fallback.
- Respect explicitly configured models and report an unavailable model clearly rather than silently substituting another.

## AI session continuity and context

- Each implementation task maintains a persistent primary OpenCode session across implementation, local validation repairs, CI repairs, human-requested changes, and subsequent remediation cycles.
- The agent should retain or have access to as much relevant task and repository context as practical across the full lifecycle, including the task, attachments, approved plan, earlier work, feedback, and outcomes.
- Restart recovery must resume the correct task session where safe, rather than silently starting a context-free replacement.
- Independent planning and implementation reviews use separate sessions to preserve independent judgment.

## Recovery-first behavior across components

- When OpenCode fails or a session becomes unavailable, first attempt to reconnect to the original task session.
- If the session is confirmed unrecoverable, the orchestrator may create a replacement session only when it can safely reconstruct the relevant context from the task, approved plan, repository, attachments, earlier changes, execution history, and feedback.
- Preserve completed work and workflow progress; never restart from scratch or repeat completed operations unnecessarily.
- Apply the same recovery-first approach to other components, including Git, GitHub, Trello, child processes, and persistent workflow state.
- Recovery must remain safe and evidence-based. If the correct state cannot be established, preserve evidence and report the blockage instead of guessing.

## Application upgrades and shutdown

- New versions must safely resume tasks started by earlier versions. Persisted workflow state must remain backward-compatible or be migrated safely, preserving task ownership, AI sessions, Git state, and progress.
- Failed or unsupported migrations must preserve the original state and report the problem rather than corrupting it. Unaffected projects continue where safe.
- On shutdown or deployment restart, including Docker termination signals, stop claiming new tasks, safely interrupt active child processes, and preserve the execution state necessary for recovery.
- Release resources only when safe and automatically resume interrupted work on the next startup.

## Configuration and instance ownership

- Validate configuration before any tasks are processed. At least one valid project must be configured; missing required settings, invalid values, and unsupported options cause startup to fail with a clear, actionable error.
- Verify required configured external resources, including Trello boards and lists, before processing tasks. Invalid configuration must not result in partial task execution.
- Support Trello Free only; no required functionality may depend on paid Trello features.
- Only one orchestrator instance may actively own and process a given project at a time, including when another instance is running locally or in Docker on the same machine.
- A second instance must respect existing project ownership rather than claiming tasks. Crash recovery and ownership release must be safe; ambiguous ownership must prevent competing execution.
- Multiple-machine coordination is out of scope for now and can be considered later. Ordinary single-machine operation must not require a shared database.

## Configuration changes and runtime isolation

- Configuration is loaded and validated at startup. Changes made while the orchestrator is running only take effect after a restart; live configuration reload is not supported.
- Active tasks must be preserved across restarts and resumed safely with the new configuration.
- Runtime failures affecting one project, such as unavailable Trello resources or expired GitHub credentials, must not unnecessarily stop other healthy projects from operating.

## Refinement templates and scope

- Refinement uses distinct default templates for `Feature`, `Improvement`, and `Bug`, based on the existing templates. The agent may adapt or omit sections that do not apply; their detailed content can be reviewed separately.
- Preserve the original task's intent and scope. Use current repository evidence to clarify the requested work, and include additional work only where strictly necessary to achieve its objective.
- Identify larger dependencies or related opportunities without silently expanding the task or introducing unrelated refactoring.
- When a task is overly large or complex, recommend splitting it into smaller tasks, but still refine the original card. Do not automatically create or split Trello cards; that capability may be considered later.

## Refinement completion and failure

- If refinement fails or produces an invalid result, the orchestrator first attempts safe recovery and bounded correction.
- Validate the complete refinement result before changing the Trello card. If refinement cannot complete, preserve the original title, description, and classification rather than leaving partial changes; move the card to `Failed` with an explanation.
- After successful refinement, return the updated card to `Backlog` and post a concise Trello comment confirming completion, the selected task type, and the total refinement duration when available.
- The completion comment must not repeat the refined description already present on the card.

## Incomplete tasks and Trello comments

- An incomplete or unclear task must not be rejected automatically. The planning agent first examines the card, current repository, and attachments to determine whether the intended work can be understood without inventing requirements.
- If essential information is still missing, post an actionable Trello comment explaining what needs clarification and move the card to `Failed`. The user may clarify it and explicitly return it to `Ready for Agent` later.
- Trello comments are reserved for meaningful outcomes or situations requiring attention, such as refinement completion, task failures, missing information, and PR closure.
- Routine operations such as validation, AI reviews, and retries belong in execution logs rather than generating noisy card comments.

## Trello card content during execution

- Implementation, validation, review, CI repair, and PR maintenance must never change a Trello card's title or description. Only an explicit refinement workflow may update them.
- Trello comments are limited to meaningful events, such as failure and clarification requests, PR publication or transition to human review, and PR closure. Do not comment on every internal activity or progress step; keep detailed progress in execution logs.

## Cross-service consistency

- Successfully completed external operations must be preserved even when subsequent steps fail. For example, if GitHub creates a PR but Trello cannot move the card to `Human Review`, retain the PR identity and retry the Trello transition safely.
- Never duplicate pull requests, commits, or other completed side effects merely because later workflow updates fail.
- Keep the affected project's next task blocked until GitHub, Trello, and persisted execution state are safely reconciled; automatically resume once consistency is verified.
- Apply this principle to all cross-service workflow transitions, not just PR publication.

## Failed task preservation and retryability

- Preserve failed tasks' worktrees, code changes, execution records, and logs for diagnosis instead of automatically discarding them.
- Preserved artifacts must never by themselves prevent a deliberate retry. Moving a card from `Failed` to `Ready for Agent` requests a new attempt; reconcile the earlier attempt automatically, safely reusing or isolating prior work as appropriate.
- Stale worktrees, locks, AI sessions, and workflow records must not permanently trap a task. Supported Trello moves should allow the user to recover blocked states without hand-editing runtime data.
- Retries and recovery actions must be bounded and must never enter uncontrolled infinite loops.
- Never bypass safety checks or assume an uncertain external operation succeeded. Where safe recovery is temporarily impossible, preserve state, explain the blocker, and resume when it can be resolved.

## Resolving incomplete implementations

- Pull request delivery takes precedence over passing quality gates. Failed validation, unresolved AI review findings, exhausted remediation attempts, and agent crashes must not block publication when Git and GitHub can safely publish the available work.
- Publish incomplete or failing implementations as draft pull requests, describing unresolved problems accurately. Move the Trello card to `Human Review` once the PR is published.
- An implementation task must not remain indefinitely in `Working`. If publication is genuinely impossible, such as during prolonged GitHub unavailability or unsafe unrecoverable Git state, reach a clearly explained recoverable failure outcome rather than silently remaining active.
- Moving to `Failed` is exceptional for implementation tasks, not the default response to an exhausted validation or review limit. Preserve work and make deliberate retries possible.

## Exceptional PR delivery outcomes

- Move an implementation task to `Failed` only when its intended workflow genuinely cannot continue, not merely because generated code, validation, or AI review is imperfect. Preserve work and explain the failure in a Trello comment.
- Never create meaningless changes or artificial commits solely to force a pull request. If the task is already satisfied, or no meaningful implementation changes can be produced despite recovery attempts, move the card to `Failed` with an explanatory comment and preserve diagnostics for a deliberate retry.
- If meaningful implementation changes are ready but GitHub remains temporarily unavailable, keep the work and retry PR publication automatically at controlled intervals until the service recovers. Notify the operator when prolonged unavailability needs attention without abandoning the implementation or creating duplicate PRs.

## Coordinating work on an active PR

- Each project has one execution queue coordinating all operations on its active task, including human-requested changes, CI repairs, rebasing, and conflict resolution. Never run concurrent operations that modify the same project or lose pending work.
- Prioritize queued operations by default: human-requested changes first, CI repairs second, and routine PR maintenance third.
- Prerequisite operations may run ahead of that order when necessary to safely complete higher-priority work, such as rebasing before applying requested changes.

## Feedback arriving during remediation

- Additional human feedback arriving while the agent is working is recorded and queued without interrupting the active OpenCode operation.
- After the current operation, process new and still-actionable feedback automatically, without losing requests or unnecessarily repeating completed work.
- An independent AI reviewer verifies that each human-requested change has actually been fulfilled before it is treated as resolved.
- Unresolved requests receive bounded internal correction attempts, and any remaining findings must be reported clearly on the existing PR rather than silently marked complete.
