# Rewrite progress

## Current checkpoint

- Branch: `refactor/p6-advisory-publication`; phase base: `92a8276` (P5 integrated).
- P6-T1 implementation is committed as `d441859`: independently optional validation
  and coverage, truthful skipped/uncertain outcomes, persistence/recovery and caller
  compatibility, including signal-terminated commands.
- The implementation baseline passed `yarn validate`: lint, formatting, typecheck
  and 1,956 tests across 156 files. Validate the final changed candidate before handoff.
- Delivery follows the [whole-phase workflow](phase-execution.md): prepare once,
  implement and review small complete tasks sequentially, then check final integration
  and validate once. No evidence reports or full-suite runs per task.
- Inspect and preserve any existing working changes before assigning tasks or staging.
  This summary does not establish completion of work beyond the committed T1 checkpoint.
- Local reviewed-task commits require explicit session authorization. Otherwise
  leave changes unstaged and uncommitted for user review. No push, PR, merge,
  deployment or P7 is authorized by the current scope.

## Remaining P6 implementation

Use the behavior contracts in the [P6 checklist](p6-execution.md), with relevant
requirements/specification sections and meaningful regression tests:

- T2: advisory planning and plan review, including unusable/unavailable advice.
- T3: bounded validation improvement; no-op, early finish and restart behavior.
- T4: separate advisory implementation review, without a verdict veto.
- T5: distinct bounded review improvement and restart behavior.
- T6: enforced source-checkout protection and safe, scoped initial commits.
- T7: truthful draft/normal publication and verified workflow transitions.
- T8: accurate descriptions, fallback content and notifications.
- T9: evidence-backed clarification/no-output handling that preserves work.
- T10: current-evidence draft-to-ready updates on the same PR.

Review completed small tasks, inspect combined P6 integration, and run `yarn validate` on the final integrated
change. P6 is not implementation-complete yet. P7–P10 have not started; P11 covers
remaining integration/regression gaps, with broader qualification only if requested.

## Known carryovers

- **Unknown process liveness:** supervisor loss with escaped descendants has no
  established stopped-execution proof. Keep the unknown-state fence; never redispatch
  a writer on an assumption that the previous execution stopped. Investigate when
  changing dependent cancellation/recovery paths.
- **Recovery accounting:** [P6 decisions](p6-decisions.md) approve three verified
  genuine failures with outage/reconstruction accounting separate. Apply and test
  that policy when touching budgets; do not reopen the approval.
- **Source protection:** useful feasibility findings are summarized in the
  [P6 guide](p6-execution.md); production integration remains to be implemented.

Do not reopen P5 or reconstruct deleted audit/evidence records. Current source,
tests and specification govern implementation. Keep useful new task guidance in
the existing selected guide and update this progress summary at meaningful checkpoints.
