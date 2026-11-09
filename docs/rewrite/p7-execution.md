# P7 — observation, scheduling and human feedback

Temporary implementation guide. Follow [delivery workflow](phase-execution.md).
Prepare small ordered tasks covering the scope, implement/review them sequentially,
then check combined integration. Read REQ-HR-001–006, REQ-SCH-002–004, REQ-TR-004,
REQ-WF-003, REQ-PR-003/007/008, and this workflow's contributions to REQ-REC-002,
REQ-IMP-004, REQ-CTX-001/003/004 and REQ-SCH-001. Read applicable criteria directly;
shared requirements do not pull later CI/maintenance/cleanup implementation here.

## Implementation order and contracts

1. Separate persistent observation from the serialized project writer. Retain
   deduplicated arrivals while execution is blocked; observations cannot mutate the
   task branch or start a second writer. Use revision and owner-generation checks.
2. Persist queue descriptors/order: human corrections before CI before maintenance,
   with explicit necessary prerequisites. Keep arrivals across restart. Maintenance
   execution itself belongs to P8.
3. Implement optional global AI capacity and durable FCFS acquisition/release.
   Distinguish project occupancy from execution slots: idle Human Review and
   dependency/capacity waits retain ownership without consuming a slot. Cover nested
   activities, busy-project requeue, cancellation and restart without fairness reset.
4. Claim current eligible Ready cards in current Trello order, including mixed
   types and start-date boundaries. Revalidate immediately before claiming.
5. Refresh current feedback separately from immutable history. Track actor/source/
   revision, edited/deleted/superseded requests and inline context. Exclude self/bot
   status triggers. OpenCode judges semantic actionability/substantive changes via a
   validated result; deterministic code enforces identities and limits. No lifetime
   feedback-round cap or repeat of an unchanged exhausted request.
6. Run correction on the same PR and primary session with refreshed attachments,
   additive commits, advisory quality and verified Working/Human Review transitions.
   Migrate old published-correction expected-location assumptions; an internal state
   name is not proof of the card's expected list.
7. Publish truthful partial/uncertain replies and managed activity/body updates,
   preserving human content and P4 uncertain-mutation reconciliation. Never resolve
   human-owned threads or claim a fix solely from an agent's declaration.
8. Observe human merge/closure during active/queued work. Fence stale completions,
   safely cancel and reconcile in-flight effects. No new push, branch resurrection
   or stale Human Review move. Preserve unshipped work; missing PID/group does not
   prove the writer stopped. Final cleanup/fresh attempts belong to P10.

## Starting points and checks

Inspect `src/orchestrator/poll-project.ts`, `run-task-session-workflow.ts`,
`run-task-session-feedback-cycle.ts`, feedback ledger/round modules, RunStore,
coordination ownership and `task-mutation-queue.ts`. Identify exact callers/state
changes from the current tree during preparation.

Reuse dispatch, feedback ledger/round, attachment, queue and ownership suites.
Use deterministic barriers for arrivals during execution, multiple projects for
capacity/FCFS, and real Git for correction/terminal races. Verify persisted order,
single-writer intervals and external outcomes, not only callback counts. Run focused
checks and focused task reviews during implementation. Follow the delivery workflow
for authorized small checkpoints, final integration review/corrections and final
`yarn validate`. No manifests, readiness registers or live qualification gates.
