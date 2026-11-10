# Agent Orchestrator — Requirements

## Document authority

This document defines the intended behavior of Agent Orchestrator, not a description of the current implementation. It is the authoritative source for the [verifiable specification](specification.md). Changes to agreed behavior must be made explicitly and reflected in the specification.

## Purpose

Agent Orchestrator automatically turns Trello tasks into implemented, tested, and reviewed GitHub pull requests using AI agents. It manages the end-to-end workflow while allowing humans to control the final outcome.

## Guaranteed workflow progress — critical invariant

- The orchestrator must never enter an infinite execution, remediation, or recovery loop. Each active operation must make progress, complete, or reach a defined and observable outcome.
- Cards must not remain indefinitely in intermediate states such as `Working` because of internal defects, stale ownership, orphaned processes, invalid records, or exhausted attempts.
- Detect stalled work and reconcile abandoned sessions, locks, and execution records automatically. Internal failures must not permanently block a project or prevent later tasks from running.
- Always prioritize safe draft PR delivery when implementation quality gates cannot pass; do not use repeated validation or AI reviews as a reason to stall publication.
- Distinguish intentional waiting (such as `Human Review` or an external service outage) from a stuck workflow. Recheck waiting conditions and resume once they clear; do not spin indefinitely or send repeated alerts.
- Genuine external dependencies or safety uncertainty may prevent immediate resolution, but such conditions must remain explicit, observable, and recoverable rather than silently stuck. No automated system can guarantee that an unavailable external service or a human decision will eventually arrive.
- A dedicated live-service testing environment is a future improvement, not a prerequisite to addressing current robustness defects.
- If an internal error remains unrecoverable after bounded recovery attempts, terminate that attempt safely instead of leaving the card in `Working` or retrying indefinitely.
- Move the card to `Failed`, explain the reason in a Trello comment, preserve work and diagnostics, and release the project to process subsequent tasks once the terminal transition is confirmed.
- This applies only when the workflow genuinely cannot continue or safely produce a PR; exhausted quality checks alone must instead lead to draft PR delivery whenever possible.
- If Trello is unavailable and the terminal move cannot be confirmed, retain and retry that pending transition safely. Never pretend the card reached `Failed` or release ownership before the state is reconciled.
- Prevent stuck workflows by designing every operation with explicit success, failure, and recovery paths. Do not rely on periodic stall detection as the normal way to make progress.
- If unexpected inconsistent state still arises, use periodic monitoring as a last-resort safety net to detect and safely recover it, including after restarts.
- Every workflow state has explicitly allowed transitions. An external transition is only considered complete after its outcome is verified; never advance internal state merely because Trello, GitHub, or another service was assumed to succeed.

## Advisory quality steps — critical invariant

- All planning, plan review, validation, coverage, implementation review, and remediation inside the `Working` phase exist to guide and improve the agent's work, **never to approve, reject, or block progress to PR publication**.
- The implementation agent may evaluate, adapt, or disregard any advisory feedback, including all of it. The orchestrator does not require agreement from an AI reviewer and does not force the agent to apply recommendations.
- An agent may finish remediation early when further changes would not be useful. Existing attempt limits are maximums, not required counts; no additional configuration or approval mechanism is needed.
- If an advisory remediation attempt produces no implementation changes, stop that remediation cycle and proceed toward publishing the existing meaningful changes. Do not repeatedly request review of unchanged code merely because the AI reviewer remains dissatisfied.
- Advisory stages have bounded execution and correction attempts. Negative findings, failed validation, exhausted correction attempts, or an unrecoverable crash of an advisory stage must not block publication; record the outcome, skip that stage when necessary, and continue toward publishing meaningful implementation changes.
- A crash must be established using execution evidence, not an unsatisfactory result. Negative AI feedback, failing tests, and normal nonzero validation results are not implementation crashes.
- A genuine crash of the primary implementation process is different: first attempt safe recovery, including restoring the existing session or reconstructing context when possible. If primary execution remains unrecoverable **before a PR has been published**, move the card to `Failed`, even when partial code changes exist. Preserve changes and diagnostics; do not automatically publish interrupted implementation work as a draft PR. **After a PR has been published**, an unrecoverable primary session or correction operation is an operation failure, not a terminal task failure: preserve the existing PR, unshipped work, and project ownership; report the blockage, make bounded safe recovery attempts, and remain in an explicit recoverable waiting state or await a human merge/closure. Never move an open-PR card to `Failed` or claim a new task simply because post-publication automation failed. A temporary external outage follows the separate preservation-and-retry policy.
- Use the existing bounded operation retry configuration for primary implementation crash recovery; do not add a separate implementation-crash retry setting. The approved limit is three verified genuine failures per primary operation, not three total outage-related process dispatches. Record actual dispatches truthfully and temporary outages separately, using bounded immediate attempts and paced rechecks. Reconstruction acknowledgement uses separate role accounting with the same existing recovery limit; validation/review improvement budgets remain separate.
- Reports must accurately distinguish what ran, what passed, what failed, what was skipped, and what remains uncertain. Publish a draft PR when significant unresolved quality problems remain; never misrepresent readiness.
- Unresolved validation failures after remediation, including repeated failures of the same checks, must be captured in the PR description and available diagnostics. Stop correction attempts at their configured limit and publish a draft PR; passing tests or eliminating validation errors is never a prerequisite for publication.
- Operational safety constraints remain mandatory: no loss of unrelated work, unsafe Git mutations, duplicate side effects, or exposure of credentials. These constraints are distinct from quality assessments and cannot be bypassed to force publication.

## Projects and task concurrency

- At least one project must be configured; multiple projects are supported.
- Each project has its own Trello board, Git repository, GitHub repository, and configuration.
- Projects are independent and may process tasks concurrently without interfering with one another.
- Each project processes only one task at a time. The current task must reach a terminal outcome before the project starts another.
- A pull request awaiting `Human Review` is still active and blocks the next task, since later work may depend on its merge.

## Trello lifecycle

- A merged pull request moves its card to `Done`.
- A pull request closed without merging moves its card to `Backlog`. The orchestrator posts a Trello comment explaining the closure and linking to the PR. The task can be revised and explicitly queued again later; closure is not an orchestrator failure.
- An unrecoverable automated failure moves its card to `Failed`, with an explanatory Trello comment and an email notification when configured. Failure conditions are defined in the recovery, PR-delivery exception, and advisory-step requirements below.
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

## Implementation planning and boundaries

- Before modifying code, the implementation agent analyzes the task, attachments, and current repository state, then prepares an implementation plan.
- An independent AI agent reviews the plan for correctness, completeness, and alignment with the task.
- Planning and independent review are advisory. The implementation agent may adapt or disregard the plan or its feedback; failed or exhausted planning/review attempts must not prevent implementation from proceeding.
- Implementation takes place in an isolated Git worktree on a task-specific branch, never in the original source checkout.
- The agent may modify source code, tests, configuration, and documentation as necessary for the task.
- The plan guides implementation but is not a mandatory approval gate. Repository safety instructions and task scope still apply; avoid unrelated modifications.

## Primary delivery requirement

**The highest-priority goal of every implementation task is to produce a GitHub pull request.**

- Every implementation task must result in a pull request, even when validation, tests, or independent AI review have unresolved failures.
- The orchestrator attempts to resolve problems automatically within configured limits, but those limits must not create an endless loop or prevent delivery.
- Any unresolved failures or review findings must be disclosed clearly in the pull request; an incomplete implementation must never be represented as validated or ready to merge.
- A failure to produce a pull request is exceptional and must have a genuine safety or external-operation reason, such as unavailable Git/GitHub services or a repository state that cannot be published safely.
- Producing a pull request is not the same as approving it for merge. Review, validation, and publication behavior are defined below; advisory quality assessments are never publication gates.

## Validation, review, and PR readiness

- The orchestrator runs configured validation commands itself, rather than relying on an agent's claim that they passed.
- Validation failures and independent AI review findings have separate configurable improvement-attempt limits. These steps provide information to the agent, which decides what feedback to act on. Relevant checks may be rerun to report the latest results.
- Exhausting either limit must not prevent PR delivery.
- Create a normal pull request when configured checks have demonstrably passed and no known material unresolved quality or human-review issues remain. Otherwise publish a draft pull request and accurately disclose failures, skipped or uncertain checks, and material outstanding findings. AI feedback is advisory: reviewer approval is never required, and declining a suggestion is not by itself a blocker; determine draft status from recorded evidence of material unresolved issues, not an AI approval decision.
- Both normal and draft pull requests move the Trello card to `Human Review`. If email notifications are configured, a PR notification is sent, explicitly identifying draft PRs and their outstanding issues.
- A draft PR may be marked ready for review when outstanding issues are addressed and its reported status is accurate; advisory review itself cannot veto delivery.
- The orchestrator never automatically merges pull requests; merging or closing is a human decision. A project cannot start its next task while its PR remains open.

## Human review and requested changes

- GitHub reviews requesting changes are handled automatically; no manual Trello action is necessary. Actionable human requests may also arrive as standalone PR comments or inline discussions. Exclude orchestrator-authored replies, its own bot-generated status updates, and non-actionable discussion from triggers. Edited comments become new work only when their substantive requested action changes; incidental edits and previously exhausted unchanged feedback must not restart remediation.
- The orchestrator collects all outstanding actionable feedback, including review summaries, inline comments, and general PR comments, retaining file and line context when available.
- It moves the card from `Human Review` to `Working`, addresses feedback on the existing task branch, and updates the same pull request rather than creating a replacement.
- It offers validation and independent AI review as bounded, advisory follow-up steps. Failed, unavailable, or negative checks cannot prevent publishing available changes to the existing PR and returning the card to `Human Review` with accurate outstanding-issue information. A bounded advisory-stage dependency outage is skipped and reported after its attempts are exhausted; preserve-and-wait applies instead when the unavailable dependency is essential to unfinished primary execution or safe Git/GitHub publication.
- Publish available changes to the existing PR regardless of independent AI verification findings. Replies must accurately describe what changed and must not claim unresolved or uncertain feedback is fulfilled.
- Feedback arriving during remediation must not be lost. After the current cycle, the orchestrator checks for newly actionable feedback and processes it without repeating unchanged remediation. Previously reported unresolved feedback alone must not trigger a perpetual new cycle; return to `Human Review` and await new or changed human input.
- Human review cycles are unlimited: new requests for changes can be submitted as often as needed. Configurable limits apply only to internal automated validation, review, and correction attempts within a cycle, never to the number of human-requested-change cycles.
- A verified human merge or unmerged closure of an existing PR takes precedence over all ongoing or queued remediation, CI repair, and branch maintenance. Stop scheduling mutations, safely interrupt work where possible, and preserve unshipped changes and diagnostics. Reconcile already-dispatched effects before terminal release; no stale operation completion may push to a closed PR, recreate a deleted branch, or move the card back to `Human Review`.
- Check the authoritative PR outcome before publishing an existing-PR correction and at other safe mutation boundaries. Because human actions may race with a check, handle late terminal outcomes and rejected pushes by reconciling the actual PR state rather than inferring that it remains open.
- The task remains active until its pull request is merged or closed.

## GitHub CI

- After a pull request is created or updated, the orchestrator observes expected GitHub CI checks within bounded waiting periods and evaluates available results. Missing, pending, failed, or timed-out checks must never prevent PR delivery or cause an indefinite working-phase wait.
- It automatically attempts to fix failed checks within a separately configurable correction limit, publishing fixes to the same PR and rerunning checks.
- A CI repair episode begins for actionable failed checks and retains one correction-attempt budget across all commits and check reruns produced by that episode. The agent's own commits, new SHAs, repeated polling, and routine target-branch synchronization never renew the exhausted budget for the same unresolved failure.
- A genuinely new human-requested-change cycle, including an explicit human request to retry a previously exhausted failure, or a materially new CI failure caused by an independent external change may begin a new episode. The orchestrator must distinguish the new trigger from previously exhausted failures and must not restart correction attempts merely because an existing check is still failing.
- Unresolved CI failures leave the PR as a draft with clear diagnostics, not an indefinitely blocked delivery.
- Checks that never start or finish must not leave the workflow waiting indefinitely; the uncertainty must be reported rather than treated as a pass.

## Automatic PR maintenance

- While a PR awaits human review, the orchestrator automatically detects when its branch needs updating or has merge conflicts with the target branch.
- For an already-published PR branch, update it by merging the latest target branch into the task branch without rewriting published commits; use an AI agent to resolve merge conflicts when needed, preserving existing work. Rebasing is allowed only before the task branch has been published or when it does not rewrite any previously published commit.
- After changes, it runs validation, independent review, and CI again and updates the same PR.
- The orchestrator must not force-push, discard work, or create replacement PRs to bypass conflicts.
- Problems it cannot safely resolve must be reported clearly with enough state preserved for recovery.

## Restart and crash recovery

- After a crash, shutdown, or container restart, the orchestrator must automatically resume interrupted work from its last verified state whenever safe.
- Preserve worktrees, code changes, AI sessions, task ownership, and workflow progress; never silently start over or duplicate commits, pull requests, Trello actions, or other side effects.
- If the previous state cannot be established safely, preserve evidence and notify the operator. Attempt bounded automatic reconciliation; when the active attempt is genuinely unrecoverable, record a failure outcome and reconcile its Trello transition before releasing project ownership. If the external state cannot be verified, keep the project in an explicit recoverable waiting state with controlled rechecks rather than silently locking it forever.
- Recovery problems in one project must not stop unrelated projects.
- Temporary unavailability, timeouts, and transient failures in Trello, GitHub, OpenCode, or other dependencies must not permanently fail a task.
- Retry transient failures with sensible bounded attempts and delays. If the dependency remains unavailable, preserve task state and periodically check for safe recovery rather than repeatedly restarting or failing the implementation.
- Resume automatically when the dependency recovers and task state is verified. Never interpret an unavailable service as proof that a resource was deleted or an operation failed.
- Notify the operator when intervention is needed without repeatedly sending duplicate alerts. Unaffected projects continue operating.

## Email notifications

- Email notifications are optional and configurable. Support these four events: refinement completed, PR ready for human review (normal or draft, with outstanding issues), attention required, and task failed.
- Notifications identify the project and task, provide relevant links and useful details, and never expose secrets.
- Email delivery is non-blocking: a notification failure must never undo successful work, change the task's workflow outcome, or prevent a PR from being delivered.
- Failed deliveries are logged and retried safely when delivery is known not to have occurred; confirmed events are deduplicated. If the transport may have accepted a message but its acknowledgment was lost, preserve the uncertain delivery outcome and do not blindly resend it: reconcile through an available provider delivery identifier or report the uncertainty for operator attention. Exactly-once receipt cannot be guaranteed without transport support.

## Logging and diagnostics

- Every task has a traceable execution history, including workflow progress, state transitions, errors, retries, recovery decisions, validation and review results, and task duration.
- Orchestrator logs contain structured workflow events and concise, sanitized diagnostic summaries; raw child-process output must never leak into orchestrator logs.
- OpenCode, Git, validation commands, and other child processes have their stdout, stderr, and streaming output recorded separately, including when they fail.
- Orchestrator diagnostics may refer to the relevant child-process log without reproducing its raw output.
- Logs are organized by project and task and remain available after completion, failure, or restart, subject to retention.
- Log retention is configurable globally, with a default of 30 days. Expired logs are cleaned up automatically, but logs belonging to active tasks must never be deleted.
- OpenCode sessions, validation commands, and other long-running operations have configurable timeouts.
- When a timeout is reached, stop the affected process and its child processes safely, preserving existing code changes, task state, and logs.
- Attempt bounded recovery when safe. A timeout alone must not unnecessarily prevent eventual PR delivery.

## Git safety and cleanup

- Never modify the configured original source checkout. All agent changes belong in isolated task worktrees and branches.
- Never force-push, overwrite unrelated remote changes, or automatically discard uncommitted work.
- Never delete branches or worktrees without verifying that they belong to the task and are safe to remove.
- After a PR is merged, automatically clean up the owned task branch and worktree when safe. If cleanup cannot be verified as safe, preserve them and report the problem.

## Pull request descriptions and working status

- The orchestrator generates a useful PR description from the actual implementation, covering the purpose and summary, significant changes, validation and test results (including failures), outstanding issues, and a link to the Trello task.
- The description is refreshed after significant changes, including human-review remediation, CI repairs, and target-branch synchronization, so it describes the current PR rather than its original implementation only.
- Whenever the agent works on an existing PR, the orchestrator prominently displays a temporary status **at the top of the PR description**, similar to Dependabot's rebase status.
- The status identifies the current activity (such as requested changes, CI repair, branch synchronization, or validation), is updated as work progresses, and is cleared when the activity finishes. It must not obscure or overwrite the underlying PR description.
- The initial implementation produces one clean commit with an automatically generated, descriptive message.
- Later review corrections, CI repairs, and other changes are recorded in additional commits on the same task branch. The orchestrator does not amend or rewrite previous commits.
- Humans may choose to squash commits when merging the pull request.

## GitHub authentication

- Support both GitHub App authentication and personal credentials, such as a personal access token.
- Each project independently chooses its GitHub authentication method.
- GitHub App authentication is preferred for its dedicated bot identity and scoped permissions, but is not mandatory.

## Project setup and quality commands

- Each project may optionally configure a setup command, run in its isolated task worktree before refinement or implementation begins. If no command is configured, setup is skipped.
- Setup is a prerequisite to starting refinement or primary implementation when configured: a nonzero exit or timeout prevents the agent from starting, preserves setup-produced changes and diagnostics, and uses bounded safe recovery; if setup cannot recover, record a genuine task failure when no PR exists, or preserve the open PR and ownership as an operational blockage. A successful setup need not be repeated unnecessarily when recovering an interrupted task. Setup output is captured separately from orchestrator logs, and failures are reported and handled safely. For refinement, setup may create necessary ignored or generated worktree files, but the refinement agent itself must not change repository content; record setup's before/after worktree effects separately and never attribute setup-generated changes to refinement.
- Record setup changes independently of agent changes, including tracked files such as lockfiles. For implementation, include setup-produced tracked changes in a task commit only when reviewed as necessary for the task; preserve but exclude unrelated setup modifications without silently discarding them. If their disposition cannot be established safely, stop publication and report the blocker rather than committing unrelated changes.
- Each project may optionally and independently configure a validation command and a test coverage command.
- The orchestrator runs each configured command itself and accurately reports its results. An unconfigured command is skipped and must not be represented as having passed.
- Not configuring either quality command must not prevent implementation or pull request delivery.

## AI model configuration

- Each project may independently configure the OpenCode model and reasoning variant for each AI activity, such as refinement, planning, implementation, independent review, remediation, and commit message generation.
- If a model or variant is not specified, let OpenCode use its own configured default rather than imposing an orchestrator-specific fallback.
- Respect explicitly configured models and report an unavailable model clearly rather than silently substituting another.

## AI session continuity and context

- Each implementation task maintains a persistent primary OpenCode session across implementation, local validation repairs, CI repairs, human-requested changes, and subsequent remediation cycles.
- The agent should retain or have access to as much relevant task and repository context as practical across the full lifecycle, including the task, attachments, available advisory plan, earlier work, feedback, and outcomes.
- Restart recovery must resume the correct task session where safe, rather than silently starting a context-free replacement.
- Independent planning and implementation reviews use separate sessions to preserve independent judgment.
- When OpenCode fails or a session becomes unavailable, first attempt to reconnect to the original task session.
- If the session is confirmed unrecoverable, the orchestrator may create a replacement session only when it can safely reconstruct the relevant context from the task, available advisory plan, repository, attachments, earlier changes, execution history, and feedback.
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
- Only one orchestrator instance may actively own and process a given project at a time, including when another instance is running locally or in Docker on the same machine. Define project ownership by canonical integration identity, not an arbitrary local project alias, and require a common host-visible coordination namespace for instances that may access the same project. Local and Docker deployments must mount or configure that namespace consistently; incompatible coordination setup must fail safely rather than permit competing owners.
- A second instance must respect existing project ownership rather than claiming tasks. Crash recovery and ownership release must be safe; ambiguous ownership must prevent competing execution.
- Multiple-machine coordination is out of scope for now and can be considered later. Ordinary single-machine operation must not require a shared database.
- Configuration is loaded and validated at startup. Changes made while the orchestrator is running only take effect after a restart; live configuration reload is not supported.
- Active tasks must be preserved across restarts and resumed safely with compatible new operational settings, such as models, commands, or polling intervals. Pin active attempts to their original project identity, Trello board/list mapping, Git repository, GitHub repository, and state location. Renaming/removing an active project, redirecting its integrations, or relocating its state must be rejected or deferred until the attempt reaches a verified terminal outcome; never silently treat the old task as absent or migrate it to new resources. Compatible state-schema upgrades at the pinned location remain permitted; they do not authorize storage relocation during an active attempt.
- Runtime failures affecting one project, such as unavailable Trello resources or expired GitHub credentials, must not unnecessarily stop other healthy projects from operating.

## Refinement templates and scope

- Refinement uses distinct default templates for `Feature`, `Improvement`, and `Bug`, based on the existing templates. The agent may adapt or omit sections that do not apply; their detailed content can be reviewed separately.
- Preserve the original task's intent and scope. Use current repository evidence to clarify the requested work, and include additional work only where strictly necessary to achieve its objective.
- Identify larger dependencies or related opportunities without silently expanding the task or introducing unrelated refactoring.
- When a task is overly large or complex, recommend splitting it into smaller tasks, but still refine the original card. Do not automatically create or split Trello cards; that capability may be considered later.
- If refinement fails or produces an invalid result, the orchestrator first attempts safe recovery and bounded correction.
- Validate the complete refinement result before changing the Trello card. Persist the original values and intended complete update before the first external write. If refinement cannot complete, reconcile or restore the original title, description, and classification rather than leaving a partial final result; move the card to `Failed` with an explanation only after that outcome is verified. If Trello is unavailable or an earlier write has an uncertain outcome, retain ownership and a pending recovery state until it can be safely reconciled; never report successful refinement or confirmed restoration without verification. Before refinement writes, including completion or rollback, compare current fields with the saved originals and verified orchestrator writes, and do not knowingly overwrite detected human changes. After writes, verify the resulting fields and inspect available change history for concurrent edits, including edits accepted between the final read and the write. Preserve recoverable human content and evidence; on conflicting or unattributable changes, pause further writes with retained project ownership and explicitly reconcile or request operator resolution before declaring completion or restoration. These checks detect and reconcile conflicts conservatively; without a supported conditional-write or serialization mechanism, they do not provide atomic compare-and-write behavior or guarantee that every concurrent overwrite can be prevented.
- After successful refinement, return the updated card to `Backlog` and post a concise Trello comment confirming completion, the selected task type, and the total refinement duration when available.
- The completion comment must not repeat the refined description already present on the card.

## Incomplete tasks and Trello comments

- An incomplete or unclear task must not be rejected automatically. The planning agent first examines the card, current repository, and attachments to determine whether the intended work can be understood without inventing requirements.
- If essential information is still missing, post an actionable Trello comment explaining what needs clarification and move the card to `Failed`. The user may clarify it and explicitly return it to `Ready for Agent` later.
- Routine operations such as validation, AI reviews, and retries belong in execution logs rather than generating noisy card comments.
- Implementation, validation, review, CI repair, and PR maintenance must never change a Trello card's title or description. Only an explicit refinement workflow may update them.
- Trello comments are limited to meaningful events, such as failure and clarification requests, PR publication or transition to human review, and PR closure. Do not comment on every internal activity or progress step; keep detailed progress in execution logs.

## Cross-service consistency

- Successfully completed external operations must be preserved even when subsequent steps fail. For example, if GitHub creates a PR but Trello cannot move the card to `Human Review`, retain the PR identity and retry the Trello transition safely.
- Never duplicate pull requests, commits, or other completed side effects merely because later workflow updates fail.
- Keep the affected project's next task blocked until GitHub, Trello, and persisted execution state are safely reconciled; automatically resume once consistency is verified.
- Apply this principle to all cross-service workflow transitions, not just PR publication.
- For each external mutation, distinguish operations that are safely repeatable, operations discoverable by a stable resource identity or correlation marker, and non-idempotent writes whose acceptance may remain ambiguous (such as Trello comments and GitHub review replies). Persist the operation identity and intent before dispatching it; use provider-supported idempotency when available.
- A timeout or a negative immediate read does not prove that an in-flight write will never complete. Do not blindly resend an ambiguous non-idempotent write: retain the pending operation and project ownership, reconcile with controlled rechecks, and report uncertainty or request operator intervention when the service cannot establish the outcome. Do not claim unconditional exactly-once effects that the service cannot guarantee. Other projects remain unaffected.

## Failed task preservation and retryability

- Preserve failed tasks' worktrees, code changes, execution records, and logs for diagnosis instead of automatically discarding them.
- Preserved artifacts must never prevent a deliberate retry. Moving a card from `Failed` to `Ready for Agent` starts a fresh attempt in a clean worktree from the latest default branch; preserve and isolate prior unfinished code and diagnostics, without automatically reusing that code.
- Stale worktrees, locks, AI sessions, and workflow records must not permanently trap a task. Supported Trello moves should allow the user to recover blocked states without hand-editing runtime data.
- Retries and recovery actions must be bounded and must never enter uncontrolled infinite loops.
- Never bypass safety checks or assume an uncertain external operation succeeded. Where safe recovery is temporarily impossible, preserve state, explain the blocker, and resume when it can be resolved.

## Resolving incomplete implementations

- Pull request delivery takes precedence over quality assessments. Failed validation, unresolved AI review findings, exhausted remediation attempts, and crashes in advisory steps must not block publication when Git and GitHub can safely publish meaningful work. An unrecoverable crash of the primary implementation process is a genuine execution failure and may instead end in `Failed` after bounded recovery.
- Publish incomplete or failing implementations as draft pull requests, describing unresolved problems accurately. Move the Trello card to `Human Review` once the PR is published.
- An implementation task must not silently remain stuck in `Working`. Prolonged GitHub unavailability is an explicit, observable waiting condition: preserve work and retry publication at controlled intervals until recovery, rather than marking the task `Failed` solely because of the outage. An unrecoverable unsafe Git state may lead to `Failed` after bounded recovery.
- Moving to `Failed` is exceptional for implementation tasks, not the default response to an exhausted validation or review limit. Preserve work and make deliberate retries possible.

## Exceptional PR delivery outcomes

- Move an implementation task to `Failed` only when its intended workflow genuinely cannot continue, not merely because generated code, validation, or AI review is imperfect. Preserve work and explain the failure in a Trello comment.
- Never create meaningless changes or artificial commits solely to force a pull request. If the task is already implemented or otherwise produces no meaningful changes despite appropriate attempts, move the card to `Failed` with an explanatory Trello comment and preserve diagnostics for a deliberate retry. An already-satisfied task uses `Failed`, not `Done`, because no PR was delivered.
- If meaningful implementation changes are ready but GitHub remains temporarily unavailable, keep the work and retry PR publication automatically at controlled intervals until the service recovers. Notify the operator when prolonged unavailability needs attention without abandoning the implementation or creating duplicate PRs.

## Coordinating work on an active PR

- Each project has one execution queue coordinating all operations on its active task, including human-requested changes, CI repairs, rebasing, and conflict resolution. Never run concurrent operations that modify the same project or lose pending work.
- Prioritize queued operations by default: human-requested changes first, CI repairs second, and routine PR maintenance third.
- Prerequisite operations may run ahead of that order when necessary to safely complete higher-priority work, such as rebasing before applying requested changes.
- Additional human feedback arriving while the agent is working is recorded and queued without interrupting the active OpenCode operation.
- After the current operation, process newly actionable feedback automatically without losing requests. Do not repeatedly restart remediation solely for unchanged, previously attempted unresolved feedback; publish the current result and return to `Human Review`.
- Independent AI verification of requested changes is advisory: its findings may guide further edits and inform PR descriptions and replies, but it must never veto publishing the implementation agent's available changes. Claims that a request was fulfilled must remain evidence-based and accurate.
- The agent may use bounded internal correction attempts and choose which findings to act on; remaining findings must be reported clearly on the existing PR rather than silently marked complete.

## Partial human-review remediation and thread ownership

- Publish the implementation agent's available corrections to the existing PR even when some feedback remains unresolved or the independent review is negative.
- Clearly distinguish resolved, unresolved, and uncertain requests. Only claim a fix with adequate supporting evidence; independent AI review is advisory and never a publication gate.
- Keep the PR as a draft while unresolved requests remain, and return the Trello card to `Human Review` for further human feedback.
- The orchestrator may reply to review threads describing verified fixes, but must not automatically resolve GitHub conversations. The human reviewer decides when a thread is resolved.
- Before each human-feedback remediation cycle, refresh review feedback from GitHub. Edited comments use their latest content; deleted or superseded comments must no longer be treated as outstanding requests. Preserve prior handling history for traceability.
- A GitHub PR approval does not complete a task or authorize a merge. Keep the card in `Human Review` until the PR is actually merged or closed.
- While an approved PR remains open, continue monitoring its state and performing necessary safe maintenance. Do not start another task in that project.

## Idempotent cleanup after merging

- After a PR is merged, cleanup must be safe and idempotent. A remote branch already deleted by GitHub counts as successfully cleaned up, not a failure.
- Remove only verified, owned local worktrees and branches when safe, move the Trello card to `Done`, and allow the next task to start.
- Repeating a cleanup operation must not cause errors solely because that cleanup already happened.
- When a PR is closed without merging, move its card to `Backlog` and safely clean up the task's owned local worktree and branch after verifying that the implementation remains available through the closed GitHub PR.
- A later move back to `Ready for Agent` starts a fresh implementation attempt from the latest accepted default branch, using the current card and attachments rather than automatically reusing rejected changes.
- The agent may inspect the closed PR as historical context but must not assume that its code or decisions were correct.
- For tasks that fail without a PR, preserve diagnostic evidence, but ensure a new attempt can begin safely without inheriting unwanted changes.
- Manually retrying a failed task starts a fresh attempt in a clean worktree from the latest default branch, based on the current Trello card and attachments.
- Preserve logs and diagnostics from earlier attempts, but never automatically reuse their unfinished code.
- Old worktrees, sessions, and execution records must not block a new, safely reconciled attempt.

## Runtime state storage

- Store durable task progress, AI session references, recovery information, and other execution state outside Git repositories and worktrees.
- The runtime storage location is configurable for both local and Docker installations, and its data survives restarts and application upgrades.
- The orchestrator manages runtime state automatically; routine operation and recovery must not require users to edit internal files manually.

## Global execution concurrency

- Support an optional global limit on how many projects can actively execute AI work at once, in addition to the one-active-task-per-project rule.
- Projects waiting for available execution capacity retain their task order and state. When no global limit is configured, there is no orchestrator-imposed cross-project concurrency limit.
- Waiting for human review does not consume a global execution slot. Such a project still cannot start another task until its PR reaches a terminal outcome, but other projects may use the available execution capacity.
- When the global execution limit is reached, waiting projects receive available capacity in first-come, first-served order. A busy project must not repeatedly bypass waiting projects; configurable project priorities are not required.
- The orchestrator automatically polls Trello and GitHub for new tasks, feedback, CI results, and PR state changes without requiring a restart.
- Use one optional global polling interval, defaulting to 15 seconds. Separate per-project polling intervals are not required.
- Temporary API failures use controlled backoff. Polling must not interfere with an operation already running.

## Task duration and stalled execution

- There is no overall timeout for an entire task. Long-running tasks may continue as needed, while individual operations retain configurable timeouts.
- Track meaningful progress for active work and detect operations that are genuinely stalled, without treating a long task as stalled merely because it has been running for hours.
- Attempt automatic, safe recovery of stalled operations, preserving existing work and continuing toward PR delivery rather than waiting indefinitely.

## Secrets and credentials

- Load sensitive credentials from environment variables or protected secret files, never directly from project configuration committed to source control.
- Never expose secrets in orchestrator or child-process logs, AI prompts, Trello comments, GitHub pull requests, or email notifications. Enforce least-privilege credential access, avoid forwarding configured secrets into unrelated processes or prompts, redact registered secret values and recognized encodings from outputs under orchestrator control, and treat attachments or repository content that may contain sensitive data as untrusted. Unknown or arbitrarily transformed secrets cannot be proven absent by finite scanners: verification must report which controlled channels and known-secret forms were actually checked without claiming universal detection.
- Provide child processes only the credentials they need for their assigned operation.
- Report authentication and authorization failures clearly without revealing sensitive values.

## Supported execution environments

- Local installations and Docker deployments are equally supported, with the same capabilities and workflow behavior.
- The application must run without requiring Docker, and runtime paths must be configurable rather than tied to container-specific locations.
- Persistent state, restart recovery, logging, Git operations, and task execution must work consistently in both environments.

## Startup dependency checks

- Before processing tasks, verify that required external tools, such as Git, OpenCode, and GitHub CLI, are installed, accessible, and compatible with the application's requirements.
- Check optional dependencies only when the relevant functionality is enabled.
- If a required dependency is missing or incompatible, prevent task execution and report a clear, actionable startup error rather than failing midway through a task.

## Automated verification and baseline

- Every important workflow must have automated tests covering normal behavior, failures, interruptions, and recovery.
- Passing unit tests alone is insufficient. Verify complete workflows, from Trello task selection through implementation, pull request delivery, human review, and final card outcomes.
- Routine tests should simulate Trello, GitHub, OpenCode, and other external failures without requiring live services.
- Establish a trustworthy baseline with realistic end-to-end verification in addition to mocked and unit tests.
