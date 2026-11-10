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
- Preserve existing working changes and staging when resuming.
- Local reviewed-task commits require explicit session authorization. Otherwise
  leave changes unstaged and uncommitted for user review. No push, PR, merge,
  deployment or P7 is authorized by the current scope.

## P6 publication checkpoints and remaining work

Use the behavior contracts in the [P6 checklist](p6-execution.md), with relevant
requirements/specification sections and meaningful regression tests:

- T6 isolation is committed in `f69ccc6`; scoped commit/setup and uncertain-commit
  recovery regressions remain intact. Follow-up: integrate the isolation dependency
  into startup/container installation and verify context/state mount boundaries.
- T7–T8 complete observed descriptions/fallbacks and notification disclosure are
  committed in `04de54d`; T9 verified no-output failure is `b3f7be3`.
- The targeted recovery check inspected all three commits in `8c46b7c..b3f7be3`
  and the unfinished T10 working changes, without reopening T1–T5.
- T10 now carries current readiness evidence through normal and trusted-commit
  publishers, refreshes the same PR while preserving human text, and verifies its
  head/body/open state before promotion. Material/unresolved human requests and
  failed/skipped/uncertain/stale checks prevent promotion. Lost acknowledgments
  reconcile through the existing durable mutation journal rather than resending.
  Explicitly cleared current review disclosures no longer restore old findings.
- Checks: `yarn test tests/initial-publication.integration.test.ts tests/publish-card.test.ts tests/publish-task-session-card.test.ts`
  passed 133 tests; `yarn typecheck` and ESLint on all changed code/tests passed.
  The earlier isolation integration test also passed. Final validation is pending.
- Remaining: isolation integration follow-up, scoped combined P6 verification,
  documentation completion and final `yarn validate`.

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
- **Source protection:** writable dispatch uses Bubblewrap; the startup/container
  dependency and mount-boundary follow-up above remains before P6 completion.

Do not reopen P5 or reconstruct deleted audit/evidence records. Current source,
tests and specification govern implementation. Keep useful new task guidance in
the existing selected guide and update this progress summary at meaningful checkpoints.
