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

## Specification coverage

Additional domains—including refinement, human review, GitHub CI, recovery, Git safety, configuration, logging, and testing—will be specified section by section. An ID identifies a behavior, not a Trello implementation task. Later verification records can reference these IDs without modifying their meaning.
