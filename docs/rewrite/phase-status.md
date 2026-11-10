# Rewrite progress

## Current checkpoint

- Phase base: `92a8276` (P5 integrated).
- P6-T1 (`d441859`), T2 (`9e9b6a4`), T3 (`ca63a51`) and T4 (`0da3bb7`) are
  committed; temporary-guide cleanup is `2940ea1`.
- T5 is implemented: distinct bounded review
  remediation, no-op/early finish, and original operation/prompt recovery through
  initial, feedback and CI callers. CI review budgets retain their episode and usage.
- Production regressions cover reservation, durable primary completion, validation
  and completed-review interruptions, plus unknown-execution fencing. Feedback
  recovery retains its original round when newer feedback is observed. Final
  validation results are reported in the task handoff.
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
