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

## Specification coverage

Additional domains—including refinement, human review, GitHub CI, recovery, Git safety, configuration, logging, and testing—will be specified section by section. An ID identifies a behavior, not a Trello implementation task. Later verification records can reference these IDs without modifying their meaning.
