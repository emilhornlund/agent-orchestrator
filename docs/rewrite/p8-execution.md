# P8 — bounded CI episodes and additive maintenance

Temporary implementation guide. Use [delivery workflow](phase-execution.md).
Read REQ-CI-001/002, REQ-MNT-001–004, REQ-GIT-001/002, REQ-PR-007 and this
workflow's contributions to REQ-HR-006, REQ-PR-008, REQ-IMP-004 and REQ-CTX-001/003.
Plan small complete tasks, not isolated helpers. Keep P6 advisory policy and P7 writer/queue/capacity
contracts. P9 refinement and P10 terminal cleanup/retry are outside this scope.

This phase is implemented and locally validated. The existing
[progress summary](phase-status.md) records its actual checks and checkpoints.
Do not automatically begin P9 or reopen completed tasks without a concrete defect.

## Implementation order and contracts

1. Discover expected checks and current-revision results from supported sources.
   Define precedence and unknown discovery outcomes from the specification, not
   fixture values. Stale success or absent registration is not a pass.
2. Persist the CI observation deadline. Never-started, queued or forever-pending
   checks end with truthful uncertainty and return to Human Review, not false
   success or task failure. Restart must not restart the clock.
3. Identify a repair episode by its verified initiating event, not head SHA.
   Persist charge before dispatch; self-generated commits, target merges, reruns,
   polling and restart do not reset the budget. Only new human work/explicit retry
   or a validated materially new independent failure can start a new episode.
4. Correct CI using the same primary session/current attachments. Retain no-op,
   early-finish and exhaustion behavior; meaningful safe output still publishes
   on the same PR with accurate draft/issues despite adverse advice.
5. Detect target advancement/conflicts on open PRs automatically, including
   approved-but-unmerged PRs. Queue maintenance using P7 priorities.
6. Merge target updates additively, preserving published commit identities. Record
   base/local/remote provenance and retain excluded dirty setup output and unshipped
   commits. Bound conflict assistance and reconcile interrupted merge/push. Never
   rebase published history, force-push, reset away work or replace the PR.
7. Maintain accurate top activity status and descriptions; clear status on finish,
   preserve human text and handle concurrent edits. Integrate terminal observation
   at edit/prepush/in-flight boundaries; no branch resurrection after closure.

## Starting points and checks

Maintenance runs by default (explicit opt-out remains supported). New operations
carry `strategy: merge`; absent strategy retains the legacy rewrite fence. The
complete merge task includes advisory quality and draft/outcome publication so it
cannot temporarily activate a quality-gated or falsely ready production writer.
Activity reporting and final CI outcome refresh follow as a separate behavior.

Inspect task-session CI-repair modules, `pr-maintenance-operation.ts`,
`pr-maintenance-store.ts`, `verify-prepared-pr-maintenance.ts`, workflow dispatch,
Git client and managed status/body consumers. Inventory existing active record
compatibility before schema changes.

Reuse `tests/run-task-session-ci-repairs.test.ts`,
`tests/task-session-maintenance-dispatch.test.ts`,
`tests/pr-maintenance-publication.integration.test.ts` and terminal suites. Use
controlled clocks for deadlines, repeated polls/restart for budget persistence and
real Git ancestry/refs for additive merges and preservation. Use focused tests and
task reviews, authorized small checkpoints, final integration review and final
`yarn validate` as described in the delivery workflow. No evidence
matrix, separate qualification driver or required live-service run.
