# Rewrite progress

## Current checkpoint

- **P7 in progress on the current branch, based on `7fafed1` (integrated P6).**
  The starting index and working tree were clean. This session authorizes small
  local P7 task/correction commits only; no push, PR, branch change or P8 work.
- P7-T1 implements current eligible Ready ordering rather than historical queue
  timestamps, across feature/improvement/bug/refinement cards. Canonical creation
  rereads order before claim. Dispatch rechecks order, type and start date before
  setup or card movement; an unstarted ineligible claim is requeued, while missing
  cards retain verified orphan retirement and interrupted writers retain recovery.
- T1 checks: `yarn test tests/task-session-dispatch.test.ts tests/task-session-refinement-scheduling.test.ts tests/task-session-terminal-pr.test.ts tests/preparing-attempt-resume.integration.test.ts`
  passed **28 tests in four files**; `yarn typecheck` and changed-file ESLint passed.
  Prettier formatted the changed files. An initial extra pre-claim read invalidated
  the existing after-claim disappearance fixture; the redundant read was removed,
  preserving the real post-claim retirement regression. Self-review inspected both
  production claim routes, queue recovery, mixed types and final eligibility checks.
  `yarn test tests/run-orchestrator.test.ts tests/card-start-eligibility.test.ts`
  also passed **49 tests**; changed-file/guide Prettier and `git diff --check` passed.
  P7 guide and roadmap scope/dependencies remain accurate and unchanged.
- P7-T2a implements the production side observer during a long `pollProject` writer.
  It retains content-deduplicated PR/feedback/CI snapshots in artifact-backed,
  owner-generation-checked attempt storage without updating the writer's task
  checkpoint or acquiring its mutation queue. It serializes its own reads, backs
  off after failures, and drains its last read before returning ownership. Missing
  prior inbox state is compatible. Mixed remote-head/terminal snapshots are rejected.
  This is observation retention, **not yet scheduling/consumption of arrivals**.
- T2a checks: `yarn test tests/active-pr-observation.test.ts tests/task-session-dispatch.test.ts tests/observe-task-session-review-cards.test.ts`
  passed **38 tests in three files**; `yarn typecheck` and changed-file ESLint passed.
  Self-review inspected the new source/tests, `pollProject` wiring, authority writes,
  timer lifetime and read races. Added final PR/head verification and insulated
  diagnostics from writer completion. No known observer-task defect remains.
- P7-T4 implements current semantic feedback refresh before T2b dispatch. Production
  observation includes standalone inline/review discussion without requiring a
  current-head changes-requested verdict, preserves inline context and API actor
  identity, and excludes automation. A read-only OpenCode classification is checked
  against exact complete source identities/revisions. Substantive changes renew a
  request; incidental edits/head/timestamp changes do not renew attempted work.
  Deleted/superseded items become inactive, prior handling is append-only, and
  supported older ledgers retain their handling state. Reserved rounds with explicit
  IDs retain their original inputs; legacy rounds still verify their operation hash.
  No-op primary correction records unresolved attempted feedback so later heads
  cannot silently restart it. Refresh now precedes contextual replies.
- T4 checks: nine focused feedback/GitHub/dispatch suites passed **135 tests**;
  `yarn test tests/task-lifecycle.integration.test.ts` passed **20 tests**;
  `yarn typecheck` and changed-file ESLint passed. The broad `yarn test` initially
  found seven lifecycle fixture failures (2,090 passed): the new semantic operation
  was incorrectly treated as implementation review by the fixture. Its explicit
  classification response fixed those failures. A later focused run caught a legacy
  reservation without feedback IDs and no-op outstanding-count compatibility; both
  were corrected without guessing identities or claiming unresolved feedback fixed.
  Self-review covered clients, current/historical ledger writes, original-operation
  recovery, selection and reply ordering. Queue/quality/terminal obligations below
  remain unfinished, not implied complete by this task.
- P7-T2b persists feedback/failed-CI/maintenance descriptors while execution holds
  the project, with unclassified feedback explicitly nondispatchable. An interruption
  between retained snapshot and descriptor is reconciled on the next observation.
  Scheduler refresh consumes current feedback, retires only verified never-started
  superseded descriptors and prioritizes human corrections before CI before routine
  maintenance. The same policy applies to specific-event claim callers, while an
  active/failed writer retains recovery priority. Persisted explicit prerequisites
  can run first and invalid/missing/cyclic prerequisites are refused. Legacy queue
  records default to dispatchable without losing order/owners. A new task event
  permits human work during failed/pending CI without falsely recording CI passed.
  Maintenance execution remains disabled for P8; only descriptors are retained here.
- T2b checks: seven focused observation/queue/dispatch/transition suites passed
  **95 tests**; lifecycle/authority/attachment checks passed **26 tests in three files**.
  Typecheck and changed-file ESLint passed. Production regression now demonstrates
  human correction superseding obsolete failed CI before a CI writer starts; it
  retains later CI-budget, late-feedback and uncertain-reply coverage. Self-review
  inspected producer/scheduler/recovery callers, queued retirement, prerequisite
  validation, schema defaults and the interrupted snapshot-to-queue handoff.
- Remaining P7 order: durable fair global AI
  capacity (T3), current semantic feedback/history (T4), same-PR correction and list
  recovery (T5), truthful replies/managed description (T6), active terminal precedence
  (T7), combined checks and final `yarn validate` (T8). These are not complete.

## Inherited P6 checkpoint

- **P6 implementation complete; distinguish local checks from PR CI.** The original
  local `yarn validate` passed lint, formatting, typecheck and **2,076 tests across
  160 files**. PR #219's first CI run (`42883831283`) instead failed one command-crash
  regression: Bash implicitly execs its last command, while CI's Dash preserves the
  shell and reports the killed child as exit `143`. This test now explicitly execs
  when requiring a supervisor signal; a separate retained-shell regression requires
  numeric `143` with no fabricated signal. Production classification is unchanged.
  Focused checks passed all 42 adapter tests locally and all seven command/shell
  cases in a disposable Debian Node 24/Dash container, plus typecheck, ESLint and
  Prettier. Final local and current-head CI results are reported in the PR/session;
  a local pass alone does not establish CI success. P6 is now integrated at `7fafed1`.
- Resume-session checkpoints: `faf726f` current-evidence same-PR promotion,
  `33e325f` isolation startup integration, `24c1d76` notification disclosure and
  product guidance, `cb9d511` integrated recovery/draft fixture coverage.
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
- Local reviewed-task commits require explicit session authorization. The current
  P6 session authorized publishing PR #219 and correcting its failed CI. That
  historical authorization does not authorize new remote Git actions here.

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
  The real isolation integration test also passed.
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
- Integrated validation initially passed lint/format/typecheck but exposed six
  fixture-contract failures. Corrections retain actual Bubblewrap exit `137` for
  an inner SIGKILL (not a fabricated outer signal), exercise real namespace startup
  probing with the isolated fixture PATH, and model required draft-state mutations
  in the existing dispatch adapters. Three verified crash failures, preserved PR
  ownership/work and recovery assertions remain enforced.
  `yarn test tests/task-session-dispatch.test.ts tests/process-adapter-matrix.integration.test.ts tests/task-lifecycle.integration.test.ts`
  passed all 70 tests; typecheck, changed-file ESLint and Prettier passed. The
  corrected integrated tree then passed full `yarn validate` as recorded above.

No P6 implementation work remains. P7 is in progress; P8–P10 have not started. P11 covers
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
  required capabilities; deployment policies must permit those namespaces. Focused
  shell behavior was checked in a disposable container; full container workflow or
  live-service qualification has not been performed.

Do not reopen P5 or reconstruct deleted audit/evidence records. Current source,
tests and specification govern implementation. Keep useful new task guidance in
the existing selected guide and update this progress summary at meaningful checkpoints.
