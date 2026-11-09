# P10 — terminal outcomes, safe cleanup and deliberate retries

Temporary implementation guide. Follow [delivery workflow](phase-execution.md).
Read REQ-TR-001–003, REQ-GIT-003–006, REQ-SCH-001, terminal REQ-PR-008/REF-005,
retry REQ-CTX-002/IMP-005, REQ-NOT-001/002 and the touched REQ-REC-005 upgrade
criteria. Plan small integrated tasks; do not separate release from required effects.
Integrate P7/P8 terminal
fencing and P9 refinement outcomes. Never delete unknown work to obtain an idle state.

## Implementation order and contracts

1. Complete required terminal effects before active-task release: merged → Done,
   unmerged closure → Backlog, genuine pre-PR failure → Failed, refinement → Backlog.
   Verify destinations and explanatory comments; retain unresolved dispatched
   mutations. Notification-only uncertainty is nonblocking and cannot undo success.
2. Make owned cleanup idempotent using common Git directory, canonical paths,
   expected branches/refs and attempt provenance. Already-absent owned resources
   or provider-deleted remote branches are safe to reconcile, not recreate.
3. Preserve dirty/staged/excluded setup output and clean local-only commits.
   Before removing unmerged closed-PR resources, establish continued accessibility
   of the implementation; failed reads or unavailable history are not proof of safety.
4. Defer unsafe cleanup with resources preserved. Release for new work only when
   noninterference and preservation are established. Unknown ownership or still-
   ambiguous mutations continue to fence the project.
5. Archive reconciled attempts and create fresh attempt/worktree/branch/session
   identities on explicit requeue. Make pointer/registry/archive creation recoverable
   across interruption without dual writers or automatic old-code inheritance.
6. Failed/closed retries start from latest accepted default and current task/
   attachments. Preserve previous unfinished code and logs separately. Closed PRs
   are optional context, not accepted implementation. Unchanged Failed cards do
   not retry automatically; normal retries need no internal-state-file edits.
7. Wire truthful terminal notifications through existing deduplication/recovery.
   Keep task release distinct from host-instance exclusion and log retention.

## Starting points and checks

Inspect `reconcile-terminal-task-session-pr.ts`, terminal failure/recovery routes,
`src/git/cleanup-worktree.ts`, attempt registry/RunStore, worktree management and
notification callers. Identify every claim-release path and supported old/current
record shape before changing shared handoffs.

Reuse terminal PR/failure, cleanup, ownership, run-store and migration suites. Use
real Git for dirty and clean-unshipped preservation, interrupted archive/fresh
handoff and deleted-branch cases. Check no next claim before reconciliation. Run
focused checks and task reviews, authorized small checkpoints, final integration
review/corrections and final `yarn validate` according to the delivery workflow.
No closed-history live qualification gate or per-variant evidence bookkeeping.
