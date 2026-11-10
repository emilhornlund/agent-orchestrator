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
  recovery regressions remain intact. Startup now probes actual Bubblewrap namespace
  capabilities before task processing and documents local/container installation
  and least-privilege policy. The real child regression verifies read-only context,
  writable session/scratch state and blocked source/metadata/runtime writes.
- T7–T8 complete observed descriptions/fallbacks and notification disclosure are
  committed in `04de54d`; T9 verified no-output failure is `b3f7be3`.
- The targeted recovery check inspected all three commits in `8c46b7c..b3f7be3`
  and the unfinished T10 working changes, without reopening T1–T5.
- T10 (`faf726f`) carries current readiness evidence through normal and trusted-commit
  publishers, refreshes the same PR while preserving human text, and verifies its
  head/body/open state before promotion. Material/unresolved human requests and
  failed/skipped/uncertain/stale checks prevent promotion. Lost acknowledgments
  reconcile through the existing durable mutation journal rather than resending.
  Explicitly cleared current review disclosures no longer restore old findings.
- Checks: `yarn test tests/initial-publication.integration.test.ts tests/publish-card.test.ts tests/publish-task-session-card.test.ts`
  passed 133 tests; `yarn typecheck` and ESLint on all changed code/tests passed.
  The earlier isolation integration test also passed. Final validation is pending.
- Isolation follow-up (`33e325f`) checks: `yarn test tests/validate-toolchain.test.ts tests/opencode-isolation.integration.test.ts tests/run-startup.test.ts`
  passed 32 tests; `yarn typecheck`, changed-file ESLint and Prettier passed.
- Combined P6 inspection covered advisory planning, separate persisted improvement
  budgets, primary failure/unknown-writer fences, setup-aware single initial commit
  and uncertain-write recovery, draft/normal descriptions and notifications,
  clarification/no-output failure reconciliation and current-evidence promotion.
  Existing production regressions cover these paths; completed T1–T5 work was not
  restarted. P7 feedback/observation and P8 CI/maintenance changes remain out of scope.
- Final integration correction: shared publisher notifications now include observed
  failed/skipped/uncertain check facts even when AI review passed. Product workflow
  and fallback-description guidance no longer describes initial checks as approval
  gates. `yarn test tests/publish-card.test.ts tests/notification-outbox.test.ts`
  passed 63 tests; `yarn typecheck`, changed-file ESLint and Prettier passed.
- Remaining: final `yarn validate` and completion checkpoint.

P6 implementation and scoped integration inspection are complete, pending final
`yarn validate`. P7–P10 have not started; P11 covers
remaining integration/regression gaps, with broader qualification only if requested.

## Known carryovers

- **Unknown process liveness:** supervisor loss with escaped descendants has no
  established stopped-execution proof. Keep the unknown-state fence; never redispatch
  a writer on an assumption that the previous execution stopped. Investigate when
  changing dependent cancellation/recovery paths.
- **Recovery accounting:** [P6 decisions](p6-decisions.md) approve three verified
  genuine failures with outage/reconstruction accounting separate. Apply and test
  that policy when touching budgets; do not reopen the approval.
- **Source protection:** writable dispatch uses Bubblewrap and startup verifies its
  required capabilities; deployment policies must permit those namespaces. No live
  container/service qualification has been run in this session.

Do not reopen P5 or reconstruct deleted audit/evidence records. Current source,
tests and specification govern implementation. Keep useful new task guidance in
the existing selected guide and update this progress summary at meaningful checkpoints.
