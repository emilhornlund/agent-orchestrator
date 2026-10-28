# Agent Orchestrator — Verifiable Specification

This specification translates the agreed behavior in [requirements.md](requirements.md) into individually identifiable, testable requirements. That document remains authoritative if a discrepancy is found; resolve discrepancies explicitly rather than silently changing the intended behavior.

Each ID is stable and must not be reused. Requirements are grouped by domain, with short context explaining why they exist. Acceptance criteria describe observable outcomes, not prescribed implementation details. This document is being developed incrementally; sections not yet specified are not excluded from the requirements baseline.

## Workflow progression (REQ-WF)

A task must make progress through verified workflow transitions. Internal defects, stale execution state, or uncontrolled retries must not strand a card in an intermediate state. Legitimate waits for human decisions or unavailable external services are different from stalled execution.

### REQ-WF-001 — Verified state transitions

The orchestrator must only treat a workflow transition involving an external service as completed after verifying its result.

**Acceptance criteria**

- An unconfirmed Trello or GitHub operation is not recorded as a successful transition.
- The orchestrator retains enough state to reconcile an uncertain outcome without duplicating external side effects.
- A subsequent retry or restart reconciles the original operation before advancing.

### REQ-WF-002 — Bounded internal progress and recovery

Internal execution, remediation, and recovery must not enter uncontrolled loops or leave an intermediate task state permanently abandoned.

**Acceptance criteria**

- Each active operation has a defined completion, recovery, or failure path.
- Exhausted internal recovery leads to a documented terminal failure when the task cannot safely continue, subject to verified Trello synchronization.
- Stale locks, abandoned sessions, and inconsistent execution records are detected and reconciled automatically; monitoring is a fallback, not the primary means of progress.

### REQ-WF-003 — Distinguish waiting from stalled execution

The orchestrator must distinguish legitimate external waiting from an internally stalled task.

**Acceptance criteria**

- An open PR awaiting human review remains an explicitly active task, without consuming a global AI execution slot.
- An unavailable external service leads to a preserved, observable waiting state with controlled rechecks rather than a busy retry loop or an assumed failure.
- When the waiting condition clears, processing resumes after verifying the relevant external and persisted state.

## Pull request delivery (REQ-PR)

A meaningful implementation should reach a GitHub pull request even when advisory quality feedback is negative. Operational safety and genuine unrecoverable execution failures remain distinct exceptions.

### REQ-PR-001 — Publish despite negative quality assessments

Planning feedback, validation, coverage, AI review, and remediation results must not serve as approval gates to PR publication.

**Acceptance criteria**

- An implementation that produces meaningful changes and fails configured validation can still publish a draft PR.
- Negative AI review, exhausted remediation, or unavailable advisory checks do not prevent publishing available changes.
- Failed or skipped checks and unresolved concerns are disclosed accurately; no successful result is fabricated.

### REQ-PR-002 — Bound advisory remediation

The orchestrator must allow the implementation agent to use or disregard advisory feedback and finish improvement attempts without requiring reviewer approval.

**Acceptance criteria**

- Configured remediation limits are maximum attempts, not mandatory iterations.
- An agent may end remediation early.
- A remediation attempt that makes no implementation changes ends that remediation cycle without reviewing unchanged code repeatedly.
- Exhaustion advances toward publication rather than moving the task to `Failed` because of review dissatisfaction.

### REQ-PR-003 — Distinguish genuine implementation failure

An actual unrecoverable primary implementation crash may fail a task, unlike failed quality checks or crashes confined to advisory steps.

**Acceptance criteria**

- Crash classification relies on execution evidence, not failed tests, nonzero test results, or negative review findings.
- The primary implementation process receives bounded recovery attempts using the existing operation retry configuration.
- If primary execution remains unrecoverable, the card moves to `Failed` with preserved partial work and diagnostics rather than automatically publishing interrupted code.
- An advisory process crash is recorded and skipped after bounded recovery, allowing PR delivery to continue.

### REQ-PR-004 — Publish normal or draft PRs accurately

The orchestrator must publish meaningful implementation changes as a normal PR when applicable quality checks pass, or as a draft PR when significant quality concerns remain unresolved.

**Acceptance criteria**

- Failing validation, tests, AI review, or exhausted remediation do not prevent safe PR publication.
- Both normal and draft PRs advance their Trello card to `Human Review` after publication is verified.
- Draft PRs identify unresolved findings without claiming readiness to merge.
- The configured PR-ready notification identifies the PR and any outstanding issues, including its draft status.

### REQ-PR-005 — Idempotent PR publication and Trello synchronization

Publishing a PR and transitioning its Trello card must remain consistent across partial failures, retries, and restarts.

**Acceptance criteria**

- When GitHub creates a PR but the Trello transition fails, the orchestrator preserves the PR identity and retries reconciliation.
- A retry does not create a duplicate PR or duplicate completed external side effects.
- The next project task remains blocked until the existing PR, Trello card, and persisted workflow state are reconciled.

### REQ-PR-006 — Preserve publication work during GitHub outages

Temporary GitHub unavailability must delay publication safely rather than discard meaningful work or fail the task solely because of the outage.

**Acceptance criteria**

- The task branch, worktree, changes, and publication progress are preserved while GitHub is unavailable.
- Publication is retried at controlled intervals after verifying earlier uncertain outcomes.
- Prolonged outages are visible and can trigger an attention notification without repeated duplicate alerts.
- Once GitHub recovers, the orchestrator resumes publication without creating another PR for the same attempt.

### REQ-PR-007 — Accurate, maintained PR descriptions

The PR description must reflect the current implementation and its known quality results.

**Acceptance criteria**

- The description includes the task purpose, significant changes, validation and test results, unresolved issues, and a Trello link.
- After relevant updates, including review corrections, CI fixes, and rebasing, the description is refreshed to describe the current PR.
- While an agent works on an existing PR, a temporary activity status appears at the top of the description and is removed when the activity finishes without overwriting the underlying content.

### REQ-PR-008 — Human control of PR outcome

Publishing a PR must not be treated as authorization to merge or as completion of the Trello task.

**Acceptance criteria**

- The orchestrator never automatically merges a PR.
- An open normal or draft PR remains associated with an active task in `Human Review`; the project does not claim another task.
- A human merge leads to the verified `Done` outcome, while closure without merge leads to the verified `Backlog` outcome.

## Trello task lifecycle (REQ-TR)

Trello reflects the task's externally visible outcome. Card transitions must be accurate and verified, and a project's next task must not begin before the preceding task reaches a confirmed terminal outcome.

### REQ-TR-001 — Merged PR completion

When the task's pull request is merged, the orchestrator must move its Trello card to `Done`.

**Acceptance criteria**

- The PR is confirmed merged before completion is recorded.
- The move to `Done` is verified before the project accepts its next task.
- Retrying reconciliation does not duplicate or reverse a completed outcome.

### REQ-TR-002 — Closed, unmerged PR outcome

When a pull request is closed without being merged, the orchestrator must return its card to `Backlog`, not `Failed`.

**Acceptance criteria**

- The orchestrator verifies that the PR was closed without merging.
- The card returns to `Backlog` with a concise comment explaining the closure and linking to the PR.
- The project may take another task after the transition is confirmed; the closed task may be deliberately queued again later.

### REQ-TR-003 — Genuine failure outcome and deliberate retry

An unrecoverable task failure must be recorded as `Failed` with sufficient explanation, and retries must be initiated by the user.

**Acceptance criteria**

- The orchestrator posts an explanatory Trello comment and sends a failure notification when configured.
- A failed card is not automatically requeued as a new task.
- Moving it from `Failed` to `Ready for Agent` requests a new attempt, with previous diagnostics preserved and no accidental reuse of unfinished code.

### REQ-TR-004 — Eligible task ordering

The orchestrator must claim eligible cards in the top-to-bottom order of `Ready for Agent`, regardless of task type.

**Acceptance criteria**

- The first eligible card is selected ahead of lower cards, whether it is a feature, improvement, bug, or refinement.
- Cards with future start dates are skipped until eligible.
- An ineligible card does not prevent selection of an eligible card farther down the list.

## Task refinement (REQ-REF)

Refinement converts a Trello card into an actionable, repository-grounded task without implementing it. It may update the card's title, description, and classification, but must preserve the original intent and protect the repository and card from partial or unrelated changes.

### REQ-REF-001 — Repository-grounded, read-only analysis

The refinement agent must examine relevant current repository evidence without modifying repository content.

**Acceptance criteria**

- Refinement has access to relevant source code, tests, configuration, documentation, and supported card attachments.
- The resulting task is grounded in observed repository state rather than unsupported assumptions.
- Refinement does not modify source files or other repository content.

### REQ-REF-002 — Actionable task classification and templates

Refinement must produce an actionable card with a suitable classification and an appropriate task structure.

**Acceptance criteria**

- The resulting classification is `Feature`, `Improvement`, or `Bug`.
- Each classification uses its distinct default template, with sections adapted or omitted where they do not apply.
- The description explains the intended work without becoming a detailed implementation plan.

### REQ-REF-003 — Preserve task intent and scope

Refinement must clarify the original request without silently expanding its scope.

**Acceptance criteria**

- The refined title and description preserve the original objective.
- Additional work is included only when strictly necessary for that objective.
- Larger dependencies and related improvements may be identified without adding unrelated refactoring.
- For oversized tasks, the result may recommend splitting work but does not automatically create or split cards.

### REQ-REF-004 — Atomic completion and failure recovery

The orchestrator must validate refinement output before applying card updates and preserve the original card content if refinement cannot complete.

**Acceptance criteria**

- The complete refinement result is checked before changing the card's title, description, or classification.
- Invalid results receive bounded, safe correction attempts.
- When refinement cannot succeed, the original title, description, and classification are preserved, and the card moves to `Failed` with an explanation.
- An unsuccessful partial update is not represented as completed refinement.

### REQ-REF-005 — Successful refinement outcome

A successfully refined card must return to `Backlog` with a concise completion comment.

**Acceptance criteria**

- The validated title, description, and classification are applied to the card.
- The card returns to `Backlog` after refinement succeeds.
- The completion comment identifies the selected task type and includes total refinement duration when available, without repeating the refined description.
- The project may select another eligible task only after the transition is verified.

## Implementation execution (REQ-IMP)

Implementation turns an eligible task into meaningful repository changes. The agent works in an isolated environment, uses current task evidence, and receives advisory planning and review feedback without allowing quality assessments to become publication gates.

### REQ-IMP-001 — Isolated task-specific Git worktree

Implementation must take place on a task-specific branch in an isolated worktree without modifying the configured original repository checkout.

**Acceptance criteria**

- Implementation changes are confined to the owned task worktree and branch.
- The configured original checkout is not modified by the agent.
- Source code, tests, configuration, and documentation may be changed when relevant to the task, without unrelated modifications.

### REQ-IMP-002 — Current task context and attachments

The implementation agent must have access to the current Trello task, relevant repository state, and supported attachments.

**Acceptance criteria**

- The agent can use the current task description and relevant repository files when determining the work.
- Supported Trello attachments, including relevant images, documents, and logs, are available when execution starts or resumes.
- Downloaded attachment context is stored outside Git worktrees; access failures are reported instead of silently ignored.

### REQ-IMP-003 — Advisory planning and independent review

The implementation agent should analyze the task and prepare a plan that receives independent AI feedback, but neither the plan nor its review may act as an approval gate.

**Acceptance criteria**

- Planning considers the task, attachments, and current repository before implementation.
- An independent AI reviewer can provide feedback on correctness, completeness, and task alignment.
- The implementation agent may adopt, adapt, or disregard the plan and feedback.
- Rejection, negative feedback, or exhaustion of bounded advisory attempts does not prevent implementation from proceeding toward PR delivery.

### REQ-IMP-004 — Primary OpenCode session continuity

An implementation task must retain its primary OpenCode session across its implementation and subsequent correction activities whenever safe.

**Acceptance criteria**

- Local validation repairs, CI repairs, human-requested changes, and later remediation cycles reuse the task's primary session when available.
- The agent retains access to relevant task context, previous changes, feedback, and outcomes.
- Independent planning and implementation reviews use separate sessions.
- After interruption, the orchestrator first attempts to restore the original session; replacement is allowed only when relevant context can be safely reconstructed.

### REQ-IMP-005 — No artificial changes for PR creation

The orchestrator must require meaningful task changes rather than manufacture a commit or PR when nothing needs implementation.

**Acceptance criteria**

- If the requested work is already implemented, the orchestrator does not introduce artificial modifications solely to produce a PR.
- If no meaningful changes can be produced despite appropriate attempts, the card moves to `Failed` with an explanatory comment and preserved diagnostics.
- Failed tasks remain eligible for a later deliberate retry under the separate clean-retry requirements.

## Validation and AI review (REQ-VAL)

Validation, coverage, independent AI review, and remediation provide evidence and recommendations to improve implementation quality. They are advisory, never approval gates: a failing, negative, unavailable, or exhausted quality step must not prevent safe publication of meaningful implementation changes.

### REQ-VAL-001 — Orchestrator-executed quality commands

The orchestrator must execute configured validation and coverage commands directly and report their observed outcomes.

**Acceptance criteria**

- Validation and coverage commands are independently optional per project.
- Each configured command is run by the orchestrator rather than accepted as passed based only on an AI agent's claim.
- An unconfigured command is recorded as skipped, not passed.
- Results accurately distinguish passed, failed, skipped, and uncertain executions.

### REQ-VAL-002 — Independent review remains advisory

Independent AI implementation review must provide feedback without controlling whether the implementation proceeds to publication.

**Acceptance criteria**

- Review findings are available to the implementation agent as recommendations.
- The agent may adopt, adapt, or disregard any or all findings.
- Negative, malformed, missing, or unavailable reviewer output is recorded but never treated as an implementation failure or publication veto.
- A reviewer is not required to approve the final implementation.

### REQ-VAL-003 — Separate bounded improvement attempts

Validation remediation and AI review remediation must have separately configurable maximum attempt counts.

**Acceptance criteria**

- Repeated failures stop correction attempts when the relevant configured limit is reached.
- The implementation agent may end remediation early when further changes would not be useful.
- If remediation produces no implementation changes, its cycle stops without repeatedly reviewing unchanged code.
- Exhaustion leads toward publishing the available implementation, not to `Failed` solely because quality findings remain.

### REQ-VAL-004 — Advisory process failures do not block delivery

Failures in advisory quality steps must be distinguished from an actual failure of the primary implementation process.

**Acceptance criteria**

- A failed test or a normal nonzero validation exit status is reported as a quality result, not classified as an implementation crash.
- A crashed or timed-out advisory step receives bounded safe recovery; if it cannot be recovered, the result is recorded and the step is skipped.
- When meaningful implementation changes exist and Git/GitHub publication is safe, an advisory failure does not prevent PR creation.

### REQ-VAL-005 — Accurate disclosure and PR readiness

The orchestrator must report quality outcomes accurately and select draft PR status when significant unresolved problems remain.

**Acceptance criteria**

- Successful validation and review permit a normal PR; unresolved validation, test, or review findings lead to a draft PR with those findings disclosed.
- Failed, skipped, and uncertain checks are not represented as successful.
- Exhausted remediation attempts cannot postpone draft PR publication.
- A draft PR may be marked ready for review after outstanding issues are addressed and its status is accurately reported, without requiring an AI reviewer's approval.

## Human review and requested changes (REQ-HR)

Human feedback on an open PR is handled automatically on its existing branch. Review and verification help the agent improve its work, but must never create an endless remediation cycle or prevent publishing available corrections.

### REQ-HR-001 — Collect actionable GitHub feedback

Before remediation, the orchestrator must gather current actionable GitHub feedback with available context.

**Acceptance criteria**

- Review summaries, inline review comments, and general PR comments are considered.
- File and line context is retained when available; feedback without inline context remains eligible.
- Edited comments are read in their latest form, and deleted or superseded comments are not treated as active requests.
- Previously handled feedback remains traceable without automatically restarting completed work.

### REQ-HR-002 — Remediate on the existing PR

Requested changes must be processed on the existing task branch and published to the same PR.

**Acceptance criteria**

- The card moves from `Human Review` to `Working` during remediation.
- Available changes are published to the existing PR rather than opening a replacement PR.
- Bounded advisory validation and independent AI verification can inform corrections but cannot veto publication.
- After the cycle, the card returns to `Human Review` with remaining issues reported accurately.

### REQ-HR-003 — Preserve feedback arriving during execution

New human feedback must not be lost or cause competing changes while another operation is running.

**Acceptance criteria**

- Feedback received during an active operation is recorded and queued without interrupting that operation.
- The orchestrator refreshes feedback after the current cycle and processes newly actionable requests.
- Multiple operations do not concurrently modify the active task branch.
- Existing unchanged, previously attempted unresolved comments do not cause an endless remediation loop.

### REQ-HR-004 — Publish partial corrections honestly

The orchestrator must publish available corrections even if not all requested changes are addressed.

**Acceptance criteria**

- Verified or otherwise available implementation corrections are pushed without waiting for every AI review finding to be resolved.
- Replies distinguish addressed, unresolved, and uncertain feedback, and never claim a fix without adequate evidence.
- Unresolved requests keep the PR in draft status with clear remaining-issue information.
- The orchestrator does not automatically resolve GitHub review threads; the human reviewer controls thread resolution.

### REQ-HR-005 — Unlimited human feedback rounds, bounded internal attempts

Human-requested-change rounds must remain available for as long as the PR is open, while automated correction cycles remain bounded.

**Acceptance criteria**

- Later new or edited requests can trigger another remediation round without a fixed lifetime limit on human feedback cycles.
- Internal validation, AI review, and correction attempts obey their configured maximums for each round.
- A round can finish despite negative AI findings, without requiring reviewer satisfaction.
- A GitHub approval does not merge or complete the task; the project remains occupied until the PR is merged or closed.

### REQ-HR-006 — Coordinate active-PR work

Human remediation, CI repair, and routine PR maintenance must be serialized for the active project.

**Acceptance criteria**

- The active project has one coordinated queue of operations on its task branch.
- Human-requested changes take priority over CI repairs, which take priority over routine maintenance by default.
- Required prerequisites, such as safely updating the branch before a requested change, may run first.
- No pending feedback or CI work is silently dropped while another operation holds the project.

## GitHub CI (REQ-CI)

GitHub CI provides additional evidence after a PR is created or updated. The orchestrator observes expected checks and offers bounded repairs, but missing, failed, or delayed CI must never trap the task or prevent delivery.

### REQ-CI-001 — Observe expected checks with bounded waiting

After PR creation or updates, the orchestrator must discover and evaluate expected GitHub CI checks without waiting indefinitely.

**Acceptance criteria**

- Available expected checks and their outcomes are recorded for the current PR revision.
- Missing, pending, and timed-out checks are reported as uncertain rather than passed.
- Waiting ends at a defined bound; a check that never starts or finishes cannot leave the card indefinitely in `Working` or block the existing PR.

### REQ-CI-002 — Bounded, advisory CI repair

The orchestrator must offer the implementation agent opportunities to address failed CI checks within a separately configurable correction limit.

**Acceptance criteria**

- Failed checks and relevant diagnostics are made available to the agent.
- The agent may publish attempted fixes to the existing PR and CI is reevaluated after updates.
- Exhausting the correction limit, or making no useful changes, ends the repair cycle without repeated reviews of unchanged code.
- CI repair is not a mandatory approval gate; unresolved failures leave the PR as draft with accurate diagnostics.

## Automatic PR maintenance (REQ-MNT)

An open PR remains under safe, coordinated maintenance while awaiting human decisions. Updating its branch and resolving conflicts must preserve its identity and existing work, and must not create another infinite correction cycle.

### REQ-MNT-001 — Detect outdated branches and merge conflicts

The orchestrator must check an open PR for target-branch updates and merge conflicts while it awaits human review.

**Acceptance criteria**

- The need for a branch update or conflict resolution is detected without requiring a manual Trello action.
- Maintenance is coordinated with human-requested changes and CI repairs, never concurrently modifying the same task branch.
- An approved but still-open PR remains eligible for safe maintenance.

### REQ-MNT-002 — Safely update the existing PR branch

When safe, the orchestrator must attempt to rebase onto the latest target branch and use the agent to resolve conflicts.

**Acceptance criteria**

- Maintenance updates the existing PR and retains previous implementation work.
- The orchestrator does not force-push, discard uncommitted changes, or replace the PR to bypass a conflict.
- Unresolved or unsafe conflicts are reported with recoverable state retained, rather than silently retried forever.

### REQ-MNT-003 — Reevaluate changes without introducing review gates

After an automated branch update or conflict resolution, the orchestrator must offer validation, independent AI review, and CI reevaluation while allowing the PR to remain published.

**Acceptance criteria**

- Updated quality outcomes and unresolved issues are reported against the existing PR.
- Negative or unavailable advisory reviews do not block publishing available safe corrections.
- The maintenance cycle finishes or reaches a clear recoverable outcome without unbounded remediation.

### REQ-MNT-004 — Maintain visible, temporary PR activity status

While working on an existing PR, the orchestrator must show a temporary activity status at the top of its description.

**Acceptance criteria**

- The status describes the current activity, such as rebasing, conflict resolution, CI repair, or requested changes.
- The underlying PR description remains intact and is updated to reflect relevant implementation changes.
- Temporary status is cleared after the activity concludes, including when it ends with unresolved findings.

## Specification coverage

Additional domains—including refinement, human review, GitHub CI, recovery, Git safety, configuration, logging, and testing—will be specified section by section. An ID identifies a behavior, not a Trello implementation task. Later verification records can reference these IDs without modifying their meaning.
