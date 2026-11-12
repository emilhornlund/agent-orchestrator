# Agent Orchestrator — Verifiable Specification

This specification translates the agreed behavior in [requirements.md](requirements.md) into
individually identifiable, testable requirements. That document remains authoritative if a
discrepancy is found; resolve discrepancies explicitly rather than silently changing the intended
behavior.

Each ID is stable and must not be reused. Requirements are grouped by domain, with short context
explaining why they exist. Acceptance criteria describe observable outcomes, not prescribed
implementation details. The full set of requirements is tracked here; proposed changes to
requirements or acceptance criteria must be reconciled with the authoritative requirements document.

## Workflow progression (REQ-WF)

A task must make progress through verified workflow transitions. Internal defects, stale execution
state, or uncontrolled retries must not strand a card in an intermediate state. Legitimate waits for
human decisions or unavailable external services are different from stalled execution.

### REQ-WF-001 — Verified state transitions

The orchestrator must only treat a workflow transition involving an external service as completed
after verifying its result.

**Acceptance criteria**

- An unconfirmed Trello or GitHub operation is not recorded as a successful transition.
- The orchestrator retains enough state to reconcile an uncertain outcome without duplicating
  external side effects.
- A subsequent retry or restart reconciles the original operation before advancing.
- Each non-idempotent external write has a persisted operation intent and stable correlation
  identity where supported; safely repeatable operations are distinguished from writes that require
  outcome discovery.
- A negative read immediately after a timeout does not prove non-acceptance. An ambiguous
  non-idempotent write is not blindly resent; controlled reconciliation preserves ownership and
  exposes unresolved uncertainty without claiming unsupported exactly-once guarantees.

### REQ-WF-002 — Bounded internal progress and recovery

Internal execution, remediation, and recovery must not enter uncontrolled loops or leave an
intermediate task state permanently abandoned.

**Acceptance criteria**

- Each active operation has a defined completion, recovery, or failure path.
- Exhausted internal recovery leads to a documented terminal failure when the task cannot safely
  continue, subject to verified Trello synchronization.
- Stale locks, abandoned sessions, and inconsistent execution records are detected and reconciled
  automatically; monitoring is a fallback, not the primary means of progress.

### REQ-WF-003 — Distinguish waiting from stalled execution

The orchestrator must distinguish legitimate external waiting from an internally stalled task.

**Acceptance criteria**

- An open PR awaiting human review remains an explicitly active task, without consuming a global AI
  execution slot.
- An unavailable external service leads to a preserved, observable waiting state with controlled
  rechecks rather than a busy retry loop or an assumed failure.
- When the waiting condition clears, processing resumes after verifying the relevant external and
  persisted state.

## Pull request delivery (REQ-PR)

A meaningful implementation should reach a GitHub pull request even when advisory quality feedback
is negative. Operational safety and genuine unrecoverable execution failures remain distinct
exceptions.

### REQ-PR-001 — Publish despite negative quality assessments

Planning feedback, validation, coverage, AI review, and remediation results must not serve as
approval gates to PR publication.

**Acceptance criteria**

- An implementation that produces meaningful changes and fails configured validation can still
  publish a draft PR.
- Negative AI review, exhausted remediation, or unavailable advisory checks do not prevent
  publishing available changes.
- Failed or skipped checks and unresolved concerns are disclosed accurately; no successful result is
  fabricated.

### REQ-PR-002 — Bound advisory remediation

The orchestrator must allow the implementation agent to use or disregard advisory feedback and
finish improvement attempts without requiring reviewer approval.

**Acceptance criteria**

- Configured remediation limits are maximum attempts, not mandatory iterations.
- An agent may end remediation early.
- A remediation attempt that makes no implementation changes ends that remediation cycle without
  reviewing unchanged code repeatedly.
- Exhaustion advances toward publication rather than moving the task to `Failed` because of review
  dissatisfaction.

### REQ-PR-003 — Distinguish genuine implementation failure

An actual unrecoverable primary implementation crash may fail a task, unlike failed quality checks
or crashes confined to advisory steps.

**Acceptance criteria**

- Crash classification relies on execution evidence, not failed tests, nonzero test results, or
  negative review findings.
- The primary implementation process receives bounded recovery attempts using the existing operation
  retry configuration: three verified genuine failures per semantic primary operation. Actual
  dispatches are recorded truthfully; recognized temporary outages do not consume that failure
  allowance. Separate reconstruction-role accounting uses the same existing limit without consuming
  primary implementation attempts; no new crash setting is introduced.
- Before PR publication, unrecoverable primary execution moves the card to `Failed` with preserved
  partial work and diagnostics rather than automatically publishing interrupted code.
- After PR publication, an unrecoverable primary correction operation preserves the existing PR and
  project ownership, reports its failure, and enters explicit recovery/waiting without marking the
  task `Failed` or starting another task.
- An advisory process crash is recorded and skipped after bounded recovery, allowing PR delivery to
  continue.

### REQ-PR-004 — Publish normal or draft PRs accurately

The orchestrator must publish meaningful implementation changes as a normal PR when applicable
quality checks pass, or as a draft PR when significant quality concerns remain unresolved.

**Acceptance criteria**

- Failing validation, tests, AI review, or exhausted remediation do not prevent safe PR publication.
- Both normal and draft PRs advance their Trello card to `Human Review` after publication is
  verified.
- Draft PRs identify material unresolved findings and failed, skipped, or uncertain checks without
  claiming readiness to merge.
- The configured PR-ready notification identifies the PR and any outstanding issues, including its
  draft status.

### REQ-PR-005 — Idempotent PR publication and Trello synchronization

Publishing a PR and transitioning its Trello card must remain consistent across partial failures,
retries, and restarts.

**Acceptance criteria**

- When GitHub creates a PR but the Trello transition fails, the orchestrator preserves the PR
  identity and retries reconciliation.
- A retry does not create a duplicate PR or duplicate completed external side effects.
- Late acceptance of an earlier timed-out request is handled without issuing an unsafe duplicate.
  The orchestrator uses discoverable PR identity and retained publication intent, and preserves
  pending uncertainty if the outcome cannot yet be determined.
- The next project task remains blocked until the existing PR, Trello card, and persisted workflow
  state are reconciled.

### REQ-PR-006 — Preserve publication work during GitHub outages

Temporary GitHub unavailability must delay publication safely rather than discard meaningful work or
fail the task solely because of the outage.

**Acceptance criteria**

- The task branch, worktree, changes, and publication progress are preserved while GitHub is
  unavailable.
- Publication is retried at controlled intervals after verifying earlier uncertain outcomes.
- Prolonged outages are visible and can trigger an attention notification without repeated duplicate
  alerts.
- Once GitHub recovers, the orchestrator resumes publication without creating another PR for the
  same attempt.

### REQ-PR-007 — Accurate, maintained PR descriptions

The PR description must reflect the current implementation and its known quality results.

**Acceptance criteria**

- The description includes the task purpose, significant changes, validation and test results,
  unresolved issues, and a Trello link.
- After relevant updates, including review corrections, CI fixes, and target-branch synchronization,
  the description is refreshed to describe the current PR.
- While an agent works on an existing PR, a temporary activity status appears at the top of the
  description and is removed when the activity finishes without overwriting the underlying content.

### REQ-PR-008 — Human control of PR outcome

Publishing a PR must not be treated as authorization to merge or as completion of the Trello task.

**Acceptance criteria**

- The orchestrator never automatically merges a PR.
- An open normal or draft PR remains associated with an active task in `Human Review`; the project
  does not claim another task.
- A human merge leads to the verified `Done` outcome, while closure without merge leads to the
  verified `Backlog` outcome.
- If a human merges or closes the PR during automation, that verified terminal outcome supersedes
  pending work. No stale completion may republish to the closed PR, recreate its branch, or return
  the card to `Human Review`.
- Stop new automated mutations, safely interrupt ongoing work, preserve unshipped changes and
  diagnostics, and reconcile in-flight effects before confirming terminal Trello state or releasing
  ownership.

## Trello task lifecycle (REQ-TR)

Trello reflects the task's externally visible outcome. Card transitions must be accurate and
verified, and a project's next task must not begin before the preceding task reaches a confirmed
terminal outcome.

### REQ-TR-001 — Merged PR completion

When the task's pull request is merged, the orchestrator must move its Trello card to `Done`.

**Acceptance criteria**

- The PR is confirmed merged before completion is recorded.
- The move to `Done` is verified before the project accepts its next task.
- Retrying reconciliation does not duplicate or reverse a completed outcome.

### REQ-TR-002 — Closed, unmerged PR outcome

When a pull request is closed without being merged, the orchestrator must return its card to
`Backlog`, not `Failed`.

**Acceptance criteria**

- The orchestrator verifies that the PR was closed without merging.
- The card returns to `Backlog` with a concise comment explaining the closure and linking to the PR.
- The project may take another task after the transition is confirmed; the closed task may be
  deliberately queued again later.

### REQ-TR-003 — Genuine failure outcome and deliberate retry

An unrecoverable task failure must be recorded as `Failed` with sufficient explanation, and retries
must be initiated by the user.

**Acceptance criteria**

- The orchestrator posts an explanatory Trello comment and sends a failure notification when
  configured.
- A failed card is not automatically requeued as a new task.
- Moving it from `Failed` to `Ready for Agent` requests a new attempt, with previous diagnostics
  preserved and no accidental reuse of unfinished code.

### REQ-TR-004 — Eligible task ordering

The orchestrator must claim eligible cards in the top-to-bottom order of `Ready for Agent`,
regardless of task type.

**Acceptance criteria**

- The first eligible card is selected ahead of lower cards, whether it is a feature, improvement,
  bug, or refinement.
- Cards with future start dates are skipped until eligible.
- An ineligible card does not prevent selection of an eligible card farther down the list.

## Task refinement (REQ-REF)

Refinement converts a Trello card into an actionable, repository-grounded task without implementing
it. It may update the card's title, description, and classification, but must preserve the original
intent and protect the repository and card from partial or unrelated changes.

### REQ-REF-001 — Repository-grounded, read-only analysis

The refinement agent must examine relevant current repository evidence without modifying repository
content.

**Acceptance criteria**

- Refinement has access to relevant source code, tests, configuration, documentation, and supported
  card attachments.
- The resulting task is grounded in observed repository state rather than unsupported assumptions.
- Refinement itself does not modify source files or other repository content; worktree changes
  caused by separately configured setup are distinguished from refinement actions.

### REQ-REF-002 — Actionable task classification and templates

Refinement must produce an actionable card with a suitable classification and an appropriate task
structure.

**Acceptance criteria**

- The resulting classification is `Feature`, `Improvement`, or `Bug`.
- Each classification uses its distinct default template, with sections adapted or omitted where
  they do not apply.
- The description explains the intended work without becoming a detailed implementation plan.

### REQ-REF-003 — Preserve task intent and scope

Refinement must clarify the original request without silently expanding its scope.

**Acceptance criteria**

- The refined title and description preserve the original objective.
- Additional work is included only when strictly necessary for that objective.
- Larger dependencies and related improvements may be identified without adding unrelated
  refactoring.
- For oversized tasks, the result may recommend splitting work but does not automatically create or
  split cards.

### REQ-REF-004 — Verified completion and failure recovery

The orchestrator must validate refinement output before applying card updates and preserve original
values and recoverable human content while reconciling incomplete or conflicting updates. Completion
is a verified workflow outcome, not an atomic Trello transaction.

**Acceptance criteria**

- The complete refinement result is checked before changing the card's title, description, or
  classification.
- Invalid results receive bounded, safe correction attempts.
- Original card values and the intended complete update are preserved before mutation. If refinement
  cannot succeed, original title, description, and classification are restored or reconciled and
  verified before recording `Failed` with an explanation.
- A partially accepted or uncertain Trello write stays in a pending reconciliation state with
  project ownership retained; it must not be reported as successful refinement, confirmed rollback,
  or completed failure.
- An unsuccessful partial update is not represented as completed refinement.
- Before refinement writes, including completion or restoration, current fields are compared with
  the original snapshot and verified orchestrator writes; detected human changes are not knowingly
  overwritten. After writes, resulting fields and available change history are checked for
  concurrent edits. Recoverable human content and evidence are preserved, and conflicting or
  unattributable changes pause further writes in explicit reconciliation with ownership retained and
  operator attention requested when needed. Read-before-write checks do not establish atomic
  compare-and-write behavior or absolute prevention of concurrent overwrites.

### REQ-REF-005 — Successful refinement outcome

A successfully refined card must return to `Backlog` with a concise completion comment.

**Acceptance criteria**

- The validated title, description, and classification are applied to the card.
- The card returns to `Backlog` after refinement succeeds.
- The completion comment identifies the selected task type and includes total refinement duration
  when available, without repeating the refined description.
- The project may select another eligible task only after the transition is verified.

## Implementation execution (REQ-IMP)

Implementation turns an eligible task into meaningful repository changes. The agent works in an
isolated environment, uses current task evidence, and receives advisory planning and review feedback
without allowing quality assessments to become publication gates.

### REQ-IMP-001 — Isolated task-specific Git worktree

Implementation must take place on a task-specific branch in an isolated worktree without modifying
the configured original repository checkout.

**Acceptance criteria**

- Implementation changes are confined to the owned task worktree and branch.
- The configured original checkout is not modified by the agent.
- Source code, tests, configuration, and documentation may be changed when relevant to the task,
  without unrelated modifications.

### REQ-IMP-002 — Current task context and attachments

The implementation agent must have access to the current Trello task, relevant repository state, and
supported attachments.

**Acceptance criteria**

- The agent can use the current task description and relevant repository files when determining the
  work.
- Supported Trello attachments, including relevant images, documents, and logs, are available when
  execution starts or resumes.
- Downloaded attachment context is stored outside Git worktrees; access failures are reported
  instead of silently ignored.

### REQ-IMP-003 — Advisory planning and independent review

The implementation agent should analyze the task and prepare a plan that receives independent AI
feedback, but neither the plan nor its review may act as an approval gate.

**Acceptance criteria**

- Planning considers the task, attachments, and current repository before implementation.
- An independent AI reviewer can provide feedback on correctness, completeness, and task alignment.
- The implementation agent may adopt, adapt, or disregard the plan and feedback.
- Rejection, negative feedback, or exhaustion of bounded advisory attempts does not prevent
  implementation from proceeding toward PR delivery.

### REQ-IMP-004 — Primary OpenCode session continuity

An implementation task must retain its primary OpenCode session across its implementation and
subsequent correction activities whenever safe.

**Acceptance criteria**

- Local validation repairs, CI repairs, human-requested changes, and later remediation cycles reuse
  the task's primary session when available.
- The agent retains access to relevant task context, previous changes, feedback, and outcomes.
- Independent planning and implementation reviews use separate sessions.
- After interruption, the orchestrator first attempts to restore the original session; replacement
  is allowed only when relevant context can be safely reconstructed.

### REQ-IMP-005 — No artificial changes for PR creation

The orchestrator must require meaningful task changes rather than manufacture a commit or PR when
nothing needs implementation.

**Acceptance criteria**

- If the requested work is already implemented, the orchestrator does not introduce artificial
  modifications solely to produce a PR.
- If no meaningful changes can be produced despite appropriate attempts, the card moves to `Failed`
  with an explanatory comment and preserved diagnostics.
- Failed tasks remain eligible for a later deliberate retry under the separate clean-retry
  requirements.

## Validation and AI review (REQ-VAL)

Validation, coverage, independent AI review, and remediation provide evidence and recommendations to
improve implementation quality. They are advisory, never approval gates: a failing, negative,
unavailable, or exhausted quality step must not prevent safe publication of meaningful
implementation changes.

### REQ-VAL-001 — Orchestrator-executed quality commands

The orchestrator must execute configured validation and coverage commands directly and report their
observed outcomes.

**Acceptance criteria**

- Validation and coverage commands are independently optional per project.
- Each configured command is run by the orchestrator rather than accepted as passed based only on an
  AI agent's claim.
- An unconfigured command is recorded as skipped, not passed.
- Results accurately distinguish passed, failed, skipped, and uncertain executions.

### REQ-VAL-002 — Independent review remains advisory

Independent AI implementation review must provide feedback without controlling whether the
implementation proceeds to publication.

**Acceptance criteria**

- Review findings are available to the implementation agent as recommendations.
- The agent may adopt, adapt, or disregard any or all findings.
- Negative, malformed, missing, or unavailable reviewer output is recorded but never treated as an
  implementation failure or publication veto.
- A reviewer is not required to approve the final implementation.

### REQ-VAL-003 — Separate bounded improvement attempts

Validation remediation and AI review remediation must have separately configurable maximum attempt
counts.

**Acceptance criteria**

- Repeated failures stop correction attempts when the relevant configured limit is reached.
- The implementation agent may end remediation early when further changes would not be useful.
- If remediation produces no implementation changes, its cycle stops without repeatedly reviewing
  unchanged code.
- Exhaustion leads toward publishing the available implementation, not to `Failed` solely because
  quality findings remain.

### REQ-VAL-004 — Advisory process failures do not block delivery

Failures in advisory quality steps must be distinguished from an actual failure of the primary
implementation process.

**Acceptance criteria**

- A failed test or a normal nonzero validation exit status is reported as a quality result, not
  classified as an implementation crash.
- A crashed, timed-out, or unavailable advisory step receives bounded safe recovery; if it cannot be
  recovered, the result is recorded and the step is skipped, even when the same service is also used
  by primary operations.
- Only a dependency required to finish primary implementation or publish safely causes preserved
  waiting instead of skipping optional advice.
- When meaningful implementation changes exist and Git/GitHub publication is safe, an advisory
  failure does not prevent PR creation.

### REQ-VAL-005 — Accurate disclosure and PR readiness

The orchestrator must report quality outcomes accurately and select draft PR status when significant
unresolved problems remain.

**Acceptance criteria**

- A normal PR is permitted when configured checks demonstrably pass and no material unresolved
  issues are known; failing, skipped, or uncertain checks, or material outstanding findings, lead to
  a draft PR with those facts disclosed.
- AI reviewer approval is not required. Disregarding an advisory suggestion alone does not force
  draft status, but recorded material unresolved concerns must not be represented as resolved.
- Failed, skipped, and uncertain checks are not represented as successful.
- Exhausted remediation attempts cannot postpone draft PR publication.
- A draft PR may be marked ready for review after outstanding issues are addressed and its status is
  accurately reported, without requiring an AI reviewer's approval.

## Human review and requested changes (REQ-HR)

Human feedback on an open PR is handled automatically on its existing branch. Review and
verification help the agent improve its work, but must never create an endless remediation cycle or
prevent publishing available corrections.

### REQ-HR-001 — Collect actionable GitHub feedback

Before remediation, the orchestrator must gather current actionable GitHub feedback with available
context.

**Acceptance criteria**

- Review summaries, inline review comments, and general PR comments are considered.
- File and line context is retained when available; feedback without inline context remains
  eligible.
- Edited comments are read in their latest form, and deleted or superseded comments are not treated
  as active requests.
- Previously handled feedback remains traceable without automatically restarting completed work.
- Standalone human PR comments and actionable inline discussions can trigger remediation, but
  orchestrator-authored replies/status updates and non-request discussion cannot. Incidental comment
  edits do not restart exhausted work; substantive changed human requests may do so.

### REQ-HR-002 — Remediate on the existing PR

Requested changes must be processed on the existing task branch and published to the same PR.

**Acceptance criteria**

- The card moves from `Human Review` to `Working` during remediation.
- Available changes are published to the existing PR rather than opening a replacement PR.
- Bounded advisory validation and independent AI verification can inform corrections but cannot veto
  publication.
- After the cycle, the card returns to `Human Review` with remaining issues reported accurately.

### REQ-HR-003 — Preserve feedback arriving during execution

New human feedback must not be lost or cause competing changes while another operation is running.

**Acceptance criteria**

- Feedback received during an active operation is recorded and queued without interrupting that
  operation.
- The orchestrator refreshes feedback after the current cycle and processes newly actionable
  requests.
- Multiple operations do not concurrently modify the active task branch.
- Existing unchanged, previously attempted unresolved comments do not cause an endless remediation
  loop.

### REQ-HR-004 — Publish partial corrections honestly

The orchestrator must publish available corrections even if not all requested changes are addressed.

**Acceptance criteria**

- Verified or otherwise available implementation corrections are pushed without waiting for every AI
  review finding to be resolved.
- Replies distinguish addressed, unresolved, and uncertain feedback, and never claim a fix without
  adequate evidence.
- Unresolved requests keep the PR in draft status with clear remaining-issue information.
- The orchestrator does not automatically resolve GitHub review threads; the human reviewer controls
  thread resolution.

### REQ-HR-005 — Unlimited human feedback rounds, bounded internal attempts

Human-requested-change rounds must remain available for as long as the PR is open, while automated
correction cycles remain bounded.

**Acceptance criteria**

- Later new or edited requests can trigger another remediation round without a fixed lifetime limit
  on human feedback cycles.
- Internal validation, AI review, and correction attempts obey their configured maximums for each
  round.
- A round can finish despite negative AI findings, without requiring reviewer satisfaction.
- A GitHub approval does not merge or complete the task; the project remains occupied until the PR
  is merged or closed.

### REQ-HR-006 — Coordinate active-PR work

Human remediation, CI repair, and routine PR maintenance must be serialized for the active project.

**Acceptance criteria**

- The active project has one coordinated queue of operations on its task branch.
- Human-requested changes take priority over CI repairs, which take priority over routine
  maintenance by default.
- Required prerequisites, such as safely updating the branch before a requested change, may run
  first.
- No pending feedback or CI work is silently dropped while another operation holds the project.
- Before publication or another safe mutation boundary, check whether the PR is still open; if merge
  or closure is verified, prioritize terminal reconciliation over queued work.
- A PR state read does not eliminate concurrent human-action races: rejected or late writes are
  reconciled against authoritative PR state, not treated as permission to republish or override the
  terminal outcome.

## GitHub CI (REQ-CI)

GitHub CI provides additional evidence after a PR is created or updated. The orchestrator observes
expected checks and offers bounded repairs, but missing, failed, or delayed CI must never trap the
task or prevent delivery.

### REQ-CI-001 — Observe expected checks with bounded waiting

After PR creation or updates, the orchestrator must discover and evaluate expected GitHub CI checks
without waiting indefinitely.

**Acceptance criteria**

- Available expected checks and their outcomes are recorded for the current PR revision.
- Missing, pending, and timed-out checks are reported as uncertain rather than passed.
- Waiting ends at a defined bound; a check that never starts or finishes cannot leave the card
  indefinitely in `Working` or block the existing PR.

### REQ-CI-002 — Bounded, advisory CI repair

The orchestrator must offer the implementation agent opportunities to address failed CI checks
within a separately configurable correction limit.

**Acceptance criteria**

- Failed checks and relevant diagnostics are made available to the agent.
- The agent may publish attempted fixes to the existing PR and CI is reevaluated after updates.
- Exhausting the correction limit, or making no useful changes, ends the repair cycle without
  repeated reviews of unchanged code.
- One repair episode retains its attempt budget across self-generated commits, CI reruns, and
  changes in commit SHA; these do not reset an exhausted episode.
- Repeated polling or routine branch synchronization cannot renew exhausted repairs of the same
  unresolved failure. A genuinely new human-requested-change cycle, including an explicit human
  request to retry a previously exhausted failure, or a materially new failure introduced by an
  independent external change may establish a new episode only when its initiating event is verified
  as new; the continued failure alone is not a new trigger.
- CI repair is not a mandatory approval gate; unresolved failures leave the PR as draft with
  accurate diagnostics.

## Automatic PR maintenance (REQ-MNT)

An open PR remains under safe, coordinated maintenance while awaiting human decisions. Updating its
branch and resolving conflicts must preserve its identity and existing work, and must not create
another infinite correction cycle.

### REQ-MNT-001 — Detect outdated branches and merge conflicts

The orchestrator must check an open PR for target-branch updates and merge conflicts while it awaits
human review.

**Acceptance criteria**

- The need for a branch update or conflict resolution is detected without requiring a manual Trello
  action.
- Maintenance is coordinated with human-requested changes and CI repairs, never concurrently
  modifying the same task branch.
- An approved but still-open PR remains eligible for safe maintenance.

### REQ-MNT-002 — Safely update the existing PR branch

When safe, the orchestrator must synchronize the existing PR branch with the latest target branch
without rewriting published task commits, using the agent to resolve conflicts when needed.

**Acceptance criteria**

- A published PR branch incorporates the latest target branch with a merge commit when necessary; a
  rebase is permitted only before publication or if it leaves every published commit unchanged.
- Maintenance updates the existing PR and retains previous implementation work.
- The orchestrator does not force-push, rewrite published commits, discard uncommitted changes, or
  replace the PR to bypass a conflict.
- Unresolved or unsafe conflicts are reported with recoverable state retained, rather than silently
  retried forever.

### REQ-MNT-003 — Reevaluate changes without introducing review gates

After an automated branch update or conflict resolution, the orchestrator must offer validation,
independent AI review, and CI reevaluation while allowing the PR to remain published.

**Acceptance criteria**

- Updated quality outcomes and unresolved issues are reported against the existing PR.
- Negative or unavailable advisory reviews do not block publishing available safe corrections.
- The maintenance cycle finishes or reaches a clear recoverable outcome without unbounded
  remediation.

### REQ-MNT-004 — Maintain visible, temporary PR activity status

While working on an existing PR, the orchestrator must show a temporary activity status at the top
of its description.

**Acceptance criteria**

- The status describes the current activity, such as target-branch synchronization, conflict
  resolution, CI repair, or requested changes.
- The underlying PR description remains intact and is updated to reflect relevant implementation
  changes.
- Temporary status is cleared after the activity concludes, including when it ends with unresolved
  findings.

## Crash recovery and workflow resilience (REQ-REC)

Recovery must restore verified workflow progress without duplicating operations or losing work.
Genuine unrecoverable execution failures may terminate a task; temporary dependency outages and
negative quality assessments do not. Waiting, retrying, and stalled execution must have distinct,
observable behavior.

### REQ-REC-001 — Resume from verified state after restart

The orchestrator must safely resume interrupted tasks after application crashes, planned shutdowns,
or container restarts.

**Acceptance criteria**

- Task ownership, progress, worktrees, code changes, and AI session references survive restarts.
- On startup, the orchestrator verifies existing state before continuing operations.
- Recovery does not silently restart completed steps or duplicate commits, PRs, or Trello actions.
- A project with an unresolved recovery issue does not prevent other healthy projects from running.

### REQ-REC-002 — Recover primary AI session and context

Interrupted implementation work must reuse its original OpenCode session when safe, or reconstruct
sufficient context before using a replacement.

**Acceptance criteria**

- Recovery first attempts to reconnect to the existing primary task session.
- A replacement session is used only when the original is confirmed unrecoverable and relevant task,
  repository, plan, attachment, change, and feedback context can be reconstructed.
- Previously completed work remains preserved; recovery does not silently start an unrelated
  implementation.
- If primary execution genuinely cannot recover within the existing bounded operation retry policy
  before PR publication, the task moves to `Failed` with preserved partial work and diagnostics
  rather than publishing interrupted changes.
- If an existing PR is open, an unrecoverable primary operation preserves that PR, unshipped work,
  and exclusive ownership; it records a recoverable operational blockage and permits further safe
  recovery or the verified human PR outcome, without terminating the task.
- Recovery does not introduce a separate implementation-crash retry setting or mistake
  unsatisfactory quality feedback for a crash.

### REQ-REC-003 — Handle temporary external outages

Temporary unavailability of Trello, GitHub, OpenCode, or other external dependencies must preserve
task state and allow eventual safe resumption.

**Acceptance criteria**

- Timeouts or unavailable responses are not interpreted as proof of deletion or failure of a
  previously attempted operation.
- Retries use controlled delays and bounded immediate attempts; prolonged unavailability becomes an
  explicit monitored waiting condition.
- Recovery verifies external outcomes before repeating side effects or resuming.
- Attention notifications can report prolonged problems without repeated duplicate alerts, and
  unrelated projects continue.

### REQ-REC-004 — Resolve stale and inconsistent workflow ownership

Abandoned processes, stale locks, and inconsistent execution records must not leave a task silently
trapped in an intermediate state.

**Acceptance criteria**

- Normal operations provide explicit success, failure, and recovery paths without relying on a
  periodic watchdog to advance.
- Monitoring detects unexpected idle or inconsistent active tasks, including after restarts, and
  attempts safe reconciliation.
- If internal recovery is exhausted and failure can be safely established, the task moves to
  `Failed` after its Trello transition is confirmed.
- When an external outcome cannot be verified, the project remains in an observable, controlled
  waiting state rather than being released unsafely or entering a busy loop.

### REQ-REC-005 — Preserve state during graceful shutdown and upgrades

Shutdowns and application upgrades must retain recoverable task state.

**Acceptance criteria**

- Shutdown stops new task claims and safely interrupts active child processes while preserving state
  needed for resumption.
- New versions resume compatible persisted state or perform safe migration without losing ownership,
  session references, or progress.
- Unsupported migrations preserve original data and report the problem rather than corrupting state.
- Startup recovery proceeds only after verifying that resumption is safe.

### REQ-REC-006 — Bound operation timeouts without a task-wide deadline

The orchestrator must bound individual operations and detect genuine stalls without imposing an
overall deadline on a task.

**Acceptance criteria**

- Individual long-running operations have configurable timeouts; on timeout the affected process and
  its child processes are stopped safely with code changes, task state, and logs preserved.
- Long tasks are not classified as stalled solely because of their elapsed duration.
- Stalled operations receive safe bounded recovery and a defined subsequent workflow outcome.
- A timeout in an advisory quality operation does not by itself prevent publishing meaningful
  implementation changes.

## Git safety, cleanup, and retries (REQ-GIT)

Git operations must preserve existing work and repository integrity. Branch and worktree cleanup is
permitted only when ownership and safety are verified. Failed or closed attempts must not obstruct a
clean, deliberately initiated retry.

### REQ-GIT-001 — Protect original checkout and unrelated work

All implementation changes must remain isolated from the configured source checkout and unrelated
repository state.

**Acceptance criteria**

- Agent modifications occur only in an owned, task-specific worktree and branch.
- The original source checkout remains unchanged.
- The orchestrator never force-pushes, overwrites unrelated remote changes, or automatically
  discards uncommitted work.

### REQ-GIT-002 — Preserve understandable, additive commit history

Implementation and subsequent corrections must be committed without rewriting previous task commits.

**Acceptance criteria**

- The initial implementation is recorded in one clean commit with a generated, descriptive message.
- Later human-review, CI, and maintenance corrections use additional commits on the existing branch.
- Earlier commits are not amended or rewritten by the orchestrator; humans may squash on merge.

### REQ-GIT-003 — Verify ownership before cleanup

The orchestrator may remove a branch or worktree only after verifying its task ownership and
confirming removal is safe.

**Acceptance criteria**

- Unknown or unowned branches and worktrees are not deleted.
- Uncommitted or otherwise unpreserved work is not silently lost during cleanup.
- If cleanup safety cannot be verified, artifacts remain intact and the problem is reported.

### REQ-GIT-004 — Idempotent cleanup after merge

After a confirmed PR merge, owned Git resources must be cleaned up safely and repeatably.

**Acceptance criteria**

- Only verified, owned local branches and worktrees are removed.
- A remote branch already deleted by GitHub is treated as already cleaned up rather than as a
  failure.
- Repeating cleanup does not fail solely because an earlier run completed it.
- The card reaches `Done` and another project task becomes eligible only after required outcome
  reconciliation.

### REQ-GIT-005 — Safe cleanup after an unmerged PR closes

Closing a PR without merging must preserve the rejected implementation as accessible history while
cleaning up verified owned resources.

**Acceptance criteria**

- The orchestrator verifies the PR closed without merging and returns its card to `Backlog`.
- Owned local worktrees and branches are removed only after verifying the implementation remains
  accessible via the closed PR and cleanup is safe.
- A later retry uses the current card and latest default branch; the closed PR may be consulted as
  history but its changes are not automatically reused.

### REQ-GIT-006 — Clean manual retries after failure

A deliberate retry of a failed task must start from clean current repository state without losing
diagnostics from earlier attempts.

**Acceptance criteria**

- Moving a card from `Failed` to `Ready for Agent` starts a fresh attempt in a clean worktree based
  on the latest default branch.
- Previous logs, execution records, and unfinished changes are preserved or safely isolated for
  diagnosis.
- Old worktrees, sessions, and locks do not prevent a new attempt after safe reconciliation.
- The new attempt does not automatically incorporate unfinished code from the failed attempt.

## Configuration and project ownership (REQ-CFG)

Configuration defines independent project integrations and runtime behavior. Invalid settings must
be identified before tasks start, while ownership and storage safeguards prevent competing instances
and preserve recoverability.

### REQ-CFG-001 — Validate configuration and external resources before processing

The orchestrator must validate its configuration and required configured external resources before
processing tasks.

**Acceptance criteria**

- At least one valid project is required; missing, invalid, or unsupported configuration produces a
  clear startup error.
- Configured required Trello boards and lists are verified before task processing.
- Invalid startup configuration does not produce partially executed tasks.

### REQ-CFG-002 — Isolate project configuration and runtime failures

Each project must independently identify its Trello board, Git repository, GitHub repository, and
configuration.

**Acceptance criteria**

- Multiple projects may be configured without sharing task state or unrelated repository changes.
- A runtime failure in one project does not unnecessarily stop healthy projects.
- No required feature depends on paid Trello functionality.

### REQ-CFG-003 — Enforce exclusive project ownership

At most one orchestrator instance on a machine may actively process a given project.

**Acceptance criteria**

- Another local or Docker instance cannot concurrently claim the same project.
- Conflicting or ambiguous ownership prevents competing execution until safely reconciled.
- Crashes and shutdowns permit safe ownership recovery without requiring a shared database;
  cross-machine coordination is not required.
- Instances targeting the same canonical Trello/GitHub project integrations coordinate through a
  common host-visible ownership namespace irrespective of local aliases or distinct task-state
  directories; missing or inconsistent coordination prevents startup or task claims safely.

### REQ-CFG-004 — Load configuration at startup only

Configuration changes must take effect on restart, not through live reload.

**Acceptance criteria**

- Running instances use the validated configuration loaded at startup.
- Changes made during execution do not silently alter active workflow behavior.
- Restart with updated operational configuration preserves and safely reconciles in-progress tasks.
- Active task identity and its Trello board/lists, Git/GitHub repositories, and state location
  remain pinned until verified completion; project removal/renaming, incompatible integration
  redirection, or runtime-path relocation is rejected or deferred, never mistaken for absent
  ownership.

### REQ-CFG-005 — Persist runtime state outside Git repositories

The orchestrator must use configurable, durable runtime storage separate from source checkouts and
task worktrees.

**Acceptance criteria**

- Task progress, AI session references, and recovery information survive restart and application
  upgrade.
- Runtime storage paths can be configured for both local and Docker execution.
- Active attempts retain their pinned runtime storage location and recoverable ownership references;
  incompatible relocation is rejected or deferred until a verified terminal outcome. Compatible
  state-schema upgrades at that location do not permit relocating active state.
- Routine recovery does not require manual editing of internal state files.

### REQ-CFG-006 — Verify required startup dependencies

Before processing tasks, the orchestrator must check the tools needed by enabled functionality.

**Acceptance criteria**

- Required tools such as Git, OpenCode, and GitHub CLI are verified as installed, accessible, and
  compatible.
- Optional dependencies are checked only when their corresponding features are enabled.
- Missing or incompatible mandatory dependencies produce actionable startup errors rather than
  mid-task failures.

## Project scheduling and polling (REQ-SCH)

Scheduling must respect Trello priority and project isolation while allowing fair use of execution
capacity. Human review keeps a project occupied but must not consume a global AI execution slot.

### REQ-SCH-001 — One active task per project

A project must not claim another task before its current task reaches a confirmed terminal outcome.

**Acceptance criteria**

- Implementation, refinement, recovery, and PR maintenance for one active task remain coordinated.
- An open PR in `Human Review` blocks new tasks in that project.
- Verified `Done`, `Failed`, closed-PR `Backlog`, or successful refinement `Backlog` outcomes
  release the project for its next eligible card.

### REQ-SCH-002 — Optional global AI concurrency limit

The orchestrator must support an optional global limit on projects actively executing AI work.

**Acceptance criteria**

- The limit applies in addition to the one-active-task-per-project restriction.
- Without an explicit limit, no orchestrator-imposed cross-project AI concurrency cap applies.
- Projects awaiting capacity retain their pending task and state.
- Projects waiting in `Human Review` do not consume global AI execution capacity.

### REQ-SCH-003 — Fair first-come, first-served scheduling

When execution capacity is constrained, waiting projects must receive slots fairly.

**Acceptance criteria**

- Available capacity is allocated in first-come, first-served order.
- A busy project cannot continuously bypass projects already waiting.
- Configurable project priority settings are not required.

### REQ-SCH-004 — Automatic polling with controlled backoff

The orchestrator must discover new work and changes to active tasks without restarts or uncontrolled
API polling.

**Acceptance criteria**

- Polling discovers eligible Trello tasks, GitHub feedback, CI results, and PR state changes.
- A single optional global polling interval defaults to 15 seconds; separate project intervals are
  not required.
- Transient API errors use controlled backoff.
- Polling does not interfere with an active operation on the same task.

## Logging and diagnostics (REQ-LOG)

Diagnostics must make workflow decisions and failures traceable without mixing raw agent or command
output into orchestrator logs. Records must remain available across restarts and obey configured
retention.

### REQ-LOG-001 — Traceable task execution history

Each task must have a traceable history of its execution and outcomes.

**Acceptance criteria**

- Records identify workflow transitions, errors, retries, recovery decisions, validation and review
  results, and task duration.
- Logs are organized by project and task and remain accessible after completion, failure, or
  restart.
- Diagnostic summaries identify relevant child-process logs when further investigation is needed.

### REQ-LOG-002 — Separate structured and raw process logs

Orchestrator logs must contain concise structured events, never raw OpenCode, Git, validation, or
other child-process output.

**Acceptance criteria**

- Child-process stdout, stderr, and streaming output are recorded separately, including on failure.
- Raw child-process text does not leak into the orchestrator's structured event log.
- Diagnostic summaries are sanitized and may reference child-process log locations without copying
  raw content.

### REQ-LOG-003 — Configurable safe retention

Log retention must be configurable globally and must not delete evidence for active tasks.

**Acceptance criteria**

- The default log retention period is 30 days unless configured otherwise.
- Expired logs are cleaned up automatically.
- Logs belonging to active tasks are preserved even when older than the retention period.

## Email notifications (REQ-NOT)

Optional email notifications communicate meaningful workflow outcomes and situations needing
attention, without blocking core task processing.

### REQ-NOT-001 — Supported notification events

The orchestrator must support four configurable email notification events.

**Acceptance criteria**

- Supported events are refinement completed, PR ready for human review, attention required, and task
  failed.
- Notifications identify the project and task and include relevant links and useful context.
- PR-ready notifications distinguish draft PRs and disclose outstanding issues.

### REQ-NOT-002 — Non-blocking and safe delivery

Email failures must not undo task progress or prevent PR publication.

**Acceptance criteria**

- An email delivery failure does not change a successful workflow outcome or block publication.
- Failed deliveries are logged and retried safely when possible.
- Retries avoid duplicate notifications for confirmed event deliveries. If an acknowledgment is lost
  after possible acceptance, preserve uncertainty and reconcile through transport evidence when
  available rather than blindly resending or claiming exactly-once receipt.

## Authentication and secrets (REQ-SEC)

Credentials must be loaded and passed securely, and GitHub authentication must be configurable per
project. Secret handling takes priority over diagnostic convenience.

### REQ-SEC-001 — Protected credential sources

Sensitive credentials must come from environment variables or protected secret files rather than
repository-committed configuration.

**Acceptance criteria**

- Credentials are not embedded directly in version-controlled project settings.
- Child processes receive only credentials needed for the operation they perform.
- Authentication and authorization failures are reported with actionable but non-sensitive details.

### REQ-SEC-002 — Prevent sensitive data disclosure

Secrets must not appear in application diagnostics, agent context, external comments, PR content, or
notifications.

**Acceptance criteria**

- Orchestrator and child-process logs are protected from disclosing secret values.
- AI prompts, Trello comments, GitHub PRs, and emails do not expose credentials.
- Errors and recovery reports preserve useful diagnostics without revealing sensitive information.
- Configured or registered credentials and known sensitive representations are withheld from
  unnecessary agent/process inputs and redacted from controlled outputs; untrusted attachments and
  repository data are handled without implicitly treating them as safe.
- Verification evidence identifies checked channels and secret forms; passing known-secret redaction
  cases does not prove arbitrary unknown or transformed secrets can never appear.

### REQ-SEC-003 — Per-project GitHub authentication

Each project must support GitHub App or personal credential authentication.

**Acceptance criteria**

- Each project independently selects its GitHub authentication method.
- GitHub App authentication is preferred but not required.
- Personal access tokens remain a supported authentication option.

## Runtime environment and agent configuration (REQ-ENV)

Local and Docker installations must provide equivalent behavior, while project-specific setup and AI
configuration remain optional and explicit. A missing optional command or model setting must not
silently invent a fallback result.

### REQ-ENV-001 — Local and Docker parity

The orchestrator must support local execution without Docker and container execution with equivalent
capabilities.

**Acceptance criteria**

- Task execution, Git operations, logging, persistent state, and restart recovery work in both
  environments.
- Runtime paths are configurable rather than tied to container-specific directories.
- Docker is not required for normal local operation.

### REQ-ENV-002 — Optional project setup command

A configured setup command must run in the isolated task worktree before refinement or
implementation; absent configuration skips setup.

**Acceptance criteria**

- Setup runs only for the appropriate project and worktree, never in the original checkout.
- For refinement, setup-generated files are tracked as setup effects; the refinement agent remains
  read-only with respect to repository content.
- Setup results and failures are captured separately from structured orchestrator logs and handled
  safely.
- Failed or timed-out configured setup prevents starting the agent, retains work and diagnostics,
  and receives bounded recovery; unrecoverable pre-PR setup produces a verified task failure, while
  post-PR setup failure retains the open PR and project ownership as a reported operational
  blockage.
- Setup-produced tracked changes are independently attributed; implementation commits contain only
  reviewed task-relevant changes, while unrelated changes are preserved without silent deletion or
  unsafe publication.
- A completed setup is not unnecessarily repeated after task recovery.
- When setup is unconfigured, the orchestrator records that it was skipped.

### REQ-ENV-003 — Per-activity OpenCode model and variant selection

Each project may independently select the OpenCode model and reasoning variant for its AI
activities.

**Acceptance criteria**

- Refinement, planning, implementation, independent review, remediation, and commit-message
  generation can each have project-specific model and variant settings.
- Missing model or variant settings defer to OpenCode's own configured defaults.
- An explicitly configured but unavailable model is reported rather than silently replaced.

## Trello task context and communication (REQ-CTX)

Card attachments and descriptions are task evidence. The orchestrator must keep task context current
while restricting card edits and comments to their agreed purposes.

### REQ-CTX-001 — Refresh and isolate attachment context

Supported Trello attachments must be available to the relevant agent at task start and after
resumption.

**Acceptance criteria**

- Supported documents, images, and logs attached to the card can be accessed during refinement and
  implementation.
- Attachments are refreshed when work starts or resumes, rather than silently relying on stale
  context.
- Downloaded attachment data is kept outside repository worktrees and access failures are reported.

### REQ-CTX-002 — Clarify genuinely incomplete tasks

The agent must examine available card and repository evidence before declaring an implementation
task too unclear to proceed.

**Acceptance criteria**

- The agent evaluates the task description, repository, and attachments before requesting
  clarification.
- If essential information cannot be inferred reliably, the card moves to `Failed` with an
  actionable Trello comment identifying what is missing.
- The user may clarify the card and explicitly return it to `Ready for Agent` for a fresh attempt.

### REQ-CTX-003 — Restrict Trello content mutations and comments

Only refinement may change a card's title, description, or classification; implementation and PR
maintenance must preserve those fields.

**Acceptance criteria**

- Implementation, validation, reviews, CI repair, and PR maintenance do not modify the Trello card
  title or description.
- Trello comments describe meaningful outcomes or attention needs, not routine validation, reviews,
  or retries.
- Fine-grained progress and diagnostic details remain in execution logs instead of cluttering the
  card.

### REQ-CTX-004 — Reconcile unexpected manual Trello moves

An unexpected manual move of an active card must not be mistaken for a successful orchestrator
transition.

**Acceptance criteria**

- The orchestrator preserves execution state and pauses the affected project rather than assuming
  the manual move completed its workflow.
- Returning the card to its expected list can trigger automatic resumption after safety
  verification.
- Unrelated projects continue; any remaining uncertainty is reported and reconciled without
  destructive assumptions.

## Automated verification (REQ-TST)

The specification must be verifiable using automated tests of observable workflow behavior, not only
isolated functions. Behavior-named test scenarios may reference these stable requirement IDs;
[verification guidance](../CONTRIBUTING.md#workflow-verification) explains how to distinguish
demonstrated results from qualification limits.

### REQ-TST-001 — Automated coverage of critical workflows

Important workflows must have automated tests of successful behavior, failure handling,
interruptions, and recovery.

**Acceptance criteria**

- Tests verify complete paths from Trello task selection through implementation, PR delivery, human
  review, and terminal card outcomes.
- Negative reviews, failing validation, exhaustion, crashes, restarts, and external interruptions
  are exercised as relevant to their requirements.
- Unit-test success alone is not accepted as evidence that an entire workflow is correct.
- End-to-end verification includes realistic integration of the complete task lifecycle, beyond
  solely mocked individual units.

### REQ-TST-002 — Repeatable simulated external failures

Routine automated verification must not depend on live Trello, GitHub, or OpenCode services.

**Acceptance criteria**

- Tests can simulate successful and failing responses from the relevant external services.
- Simulated errors cover partial external success, timeouts, delayed or missing results, and
  recovery after restart.
- Verification checks observable outcomes such as PR count, card state, preserved work, and bounded
  attempts rather than relying only on agent-reported success.

### REQ-TST-003 — Traceable compliance evidence

Each specified requirement must remain independently assessable without assuming that the presence
of implementation code proves compliance.

**Acceptance criteria**

- Stable requirement IDs can be referenced by later test scenarios, implementation audits, and
  correction tasks.
- Verification distinguishes demonstrated behavior from untested, partial, or missing coverage.
- The verification baseline includes realistic end-to-end workflow evidence in addition to mocked
  and unit tests; simulated service failures remain suitable for routine automated checks.
- A dedicated live-service testing environment is a possible future improvement, not a prerequisite
  to addressing current robustness defects.

## Specification coverage and traceability

The table maps every behavioral section in [requirements.md](requirements.md) to its specification
counterparts. This is documentation traceability, **not** a claim that the application satisfies
these requirements. The introductory `Document authority` and `Purpose` sections govern document
process and intent rather than separately testable application behavior.

| Source section in `requirements.md`                   | Specification IDs                    |
| ----------------------------------------------------- | ------------------------------------ |
| Guaranteed workflow progress — critical invariant     | REQ-WF-001–003, REQ-REC-004          |
| Advisory quality steps — critical invariant           | REQ-PR-001–003, REQ-VAL-001–005      |
| Projects and task concurrency                         | REQ-CFG-002, REQ-SCH-001–002         |
| Trello lifecycle                                      | REQ-TR-001–003                       |
| Task selection                                        | REQ-TR-004                           |
| Task types and refinement                             | REQ-REF-001–005                      |
| Unexpected manual Trello moves                        | REQ-CTX-004                          |
| Trello attachments                                    | REQ-CTX-001, REQ-IMP-002             |
| Implementation planning and boundaries                | REQ-IMP-001, REQ-IMP-003             |
| Primary delivery requirement                          | REQ-PR-001, REQ-PR-004               |
| Validation, review, and PR readiness                  | REQ-VAL-001–005, REQ-PR-004          |
| Human review and requested changes                    | REQ-HR-001–005                       |
| GitHub CI                                             | REQ-CI-001–002                       |
| Automatic PR maintenance                              | REQ-MNT-001–004                      |
| Restart and crash recovery                            | REQ-REC-001–004                      |
| Email notifications                                   | REQ-NOT-001–002                      |
| Logging and diagnostics                               | REQ-LOG-001–003, REQ-REC-006         |
| Git safety and cleanup                                | REQ-GIT-001, REQ-GIT-003–004         |
| Pull request descriptions and working status          | REQ-PR-007, REQ-MNT-004, REQ-GIT-002 |
| GitHub authentication                                 | REQ-SEC-003                          |
| Project setup and quality commands                    | REQ-ENV-002, REQ-VAL-001             |
| AI model configuration                                | REQ-ENV-003                          |
| AI session continuity and context                     | REQ-IMP-004, REQ-REC-002             |
| Application upgrades and shutdown                     | REQ-REC-005                          |
| Configuration and instance ownership                  | REQ-CFG-001–004                      |
| Refinement templates and scope                        | REQ-REF-002–005                      |
| Incomplete tasks and Trello comments                  | REQ-CTX-002–003                      |
| Cross-service consistency                             | REQ-WF-001, REQ-PR-005               |
| Failed task preservation and retryability             | REQ-GIT-006, REQ-REC-004             |
| Resolving incomplete implementations                  | REQ-PR-001, REQ-PR-003–006           |
| Exceptional PR delivery outcomes                      | REQ-IMP-005, REQ-PR-003, REQ-PR-006  |
| Coordinating work on an active PR                     | REQ-HR-003, REQ-HR-006               |
| Partial human-review remediation and thread ownership | REQ-HR-001, REQ-HR-004–005           |
| Idempotent cleanup after merging                      | REQ-GIT-004–006                      |
| Runtime state storage                                 | REQ-CFG-005                          |
| Global execution concurrency                          | REQ-SCH-002–004                      |
| Task duration and stalled execution                   | REQ-REC-004, REQ-REC-006             |
| Secrets and credentials                               | REQ-SEC-001–002                      |
| Supported execution environments                      | REQ-ENV-001                          |
| Startup dependency checks                             | REQ-CFG-006                          |
| Automated verification and baseline                   | REQ-TST-001–003                      |

### Audit rules

- Requirement IDs remain unique and are not renumbered when sections change.
- Every entry must have observable acceptance criteria. A requirement is not implemented merely
  because its identifier is mapped to a source section.
- When changing the baseline, compare source statements and acceptance criteria for omissions,
  contradictions, or accidental tightening of behavior; resolve differences against the
  authoritative requirements document.
- Regression tests and implementation assessments reference these stable requirement IDs where
  useful; documentation alone does not establish that behavior is implemented or verified.
