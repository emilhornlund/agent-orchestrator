# P7 execution packet — observation, scheduling and human feedback

## Entry and boundary

Use [phase execution](phase-execution.md). Status: **packet prepared; readiness not
executed**. Pin the actual P6 integration baseline, inherited schema/evidence and
carryovers. P6 is a dependency contract, not a claim that every global requirement
was qualified. Preserve P5 fail-closed recovery and setup exclusions.

Objective: observe arrivals while one project writer executes; coordinate fair AI
capacity and actionable human corrections on the same PR. Non-goals: P8's CI episode
or merge-maintenance implementation, P9 refinement compensation, and P10 historical
cleanup/fresh attempts. Terminal observation/fencing is owned here; final resource
cleanup and clean retry are owned by P10.

## Readiness and contracts

- P7-R0: baseline + finite manifest + harness readiness, using R-BASE/R-RUNNER/
  R-UPGRADE. Inventory observer/writer entry points and every branch-mutating caller.
- P7-R1: resolve [R-CAPACITY](phase-readiness.md): exact slot lifetime, durable
  FCFS queue, nested activities, waits, cancellation, restart and release.
- P7-R2: resolve R-FEEDBACK and R-A5-MOVE before semantic dispatch or transition
  changes. R-LIVE must cover required feedback/reply/thread/manual-move observations.
- P7-R3: verify C2/process-boundary carryovers for touched cancellation paths.
  Never infer stopped execution from missing PID/group or a terminal PR alone.

Write the observer/writer contract before concurrency code: observations may append
deduplicated arrivals under revision checks but cannot dispatch mutations. One
serialized writer owns operation/generation and branch changes. Terminal outcome
invalidates future work; already dispatched effects remain reconciled, not erased.

Specify durable expected Trello location per owning operation. Changing feedback
from Human Review to Working must migrate P5's published-correction checkpoints;
internal implementation/validation/review phases alone cannot establish card location.

Semantic actionability/substantive-change judgment belongs to OpenCode. A strict
result binds current feedback revisions/actor sources and uncertainty; deterministic
rules enforce identity/history and exclude self/status content. No lifetime round cap.

## Ordered vertical tasks

| ID     | One observable result                                                  | Decisive verification                                                                                                            |
| ------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| P7-T1  | Observer retains arrivals during a blocked writer                      | Actual barrier, persistent arrival IDs, no competing branch writer                                                               |
| P7-T2  | Serialized queue orders human, CI and maintenance descriptors          | Persisted priorities and justified prerequisite, restart, no lost arrival; maintenance execution may remain unavailable until P8 |
| P7-T3  | AI slot acquisition/release matches configured cap                     | Multiple projects; absent cap; review/dependency wait does not consume execution; task ownership remains                         |
| P7-T4  | Durable FCFS waiters cannot be bypassed                                | A/B/C arrival order, busy project requeue, cancellation/restart without fairness reset                                           |
| P7-T5  | New claims follow current eligible Trello order                        | Mixed task types/start-date boundaries and reorder between claims; revalidate before claim                                       |
| P7-T6  | Feedback refresh keeps current requests and immutable history separate | Edited/deleted/superseded sources, actor identity, inline context, no self/status triggers                                       |
| P7-T7  | Validated semantic judgment selects new work only                      | Substantive versus cosmetic edit, exhausted unchanged request, malformed/uncertain judgment preserves explicit outcome           |
| P7-T8  | Same-PR correction uses verified Working/Human Review transitions      | Primary session reuse/current attachments, additive commit, adverse advice does not veto available safe output                   |
| P7-T9  | Replies disclose partial/uncertain results without resolving threads   | Evidence-bound fix claims; P4 uncertain-reply reconciliation; no duplicate or thread-resolution mutation                         |
| P7-T10 | Verified merge/close fences active and queued corrections              | Edit/prepush/dispatched-push races; no new push/branch recreation/stale Human Review transition; preserve unshipped work         |
| P7-T11 | Feedback activity/description stays current and preserves human text   | Top managed status, progress changes/clear, restart, concurrent body edit readback                                               |
| P7-V   | Capacity/feedback/terminal slices compose                              | Global cap-one human wait/B progress, arrivals during execution and human terminal race through application boundary             |

Each task includes necessary caller/schema changes and its own regression; do not
delegate this entire concurrency phase as one task.

## Criterion/variant ownership

Expand these rows into exact manifest cases, including their required evidence
levels. A complete canonical scenario remains partial until its other owners finish.

| Requirements / ACs                                                                 | Canonical scenarios                                           | P7 ownership                                                                                                                                    | Later/shared composition                                                                                      |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| REQ-HR-001 AC1–AC5                                                                 | VER-HR-001-01                                                 | All current-source/actor/revision/actionability variants; unit/integration, realistic API counterpart as specified                              | P11 realistic complete lifecycle                                                                              |
| REQ-HR-002 AC1–AC4; REQ-HR-003 AC1–AC4                                             | VER-HR-002-01; VER-HR-003-01                                  | Same PR, verified Working transition, concurrent arrivals, no unchanged loop; required simulated E2E                                            | P8 owns new CI/maintenance execution behavior                                                                 |
| REQ-HR-004 AC1–AC4; REQ-HR-005 AC1–AC4                                             | VER-HR-004-01; VER-HR-005-01                                  | Partial corrections/replies, human-owned threads, new rounds and bounded internal attempts; real reply/thread evidence required where specified | P11 broad lifecycle qualification                                                                             |
| REQ-HR-006 AC1–AC6                                                                 | VER-HR-006-01; VER-PR-008-02                                  | Queue descriptors/order/prerequisites and terminal observation/fencing/in-flight effects                                                        | P8 executes maintenance/CI descriptors; P10 terminal artifacts/retry                                          |
| REQ-SCH-002–004, all ACs; REQ-TR-004 AC1–AC3                                       | VER-SCH-002-01; VER-SCH-003-01; VER-SCH-004-01; VER-TR-004-01 | Capacity, FCFS, current eligibility, automatic observation and backoff; no later maintenance implementation needed to test queue ordering       | P11 complete environment/lifecycle                                                                            |
| REQ-WF-003 AC1–AC3                                                                 | VER-WF-003-01                                                 | Capacity-one A human wait/B execution plus inherited essential-dependency preservation                                                          | P5 recovery evidence reused only for matching tree/behavior; final release composition P11                    |
| REQ-PR-007 AC2/AC3, feedback slice; REQ-MNT-004 feedback status contribution       | VER-PR-007-01; VER-MNT-004-01                                 | Feedback description/status through complete/end-with-issues/restart                                                                            | Initial body P6, CI/maintenance P8; no full all-activity pass here                                            |
| REQ-PR-008 AC1/AC2 and fencing part AC4/AC5; REQ-SCH-001 ownership slice           | VER-PR-008-01/02; VER-SCH-001-01                              | No automatic merge, open PR occupancy, terminal priority, no stale dispatch/unsafe release                                                      | P10 final outcome/cleanup/archive/fresh retry variants                                                        |
| REQ-PR-003 AC4; REQ-REC-002 AC5; REQ-IMP-004 correction slice; REQ-CTX-004 AC1–AC3 | VER-PR-003-03; VER-IMP-004-01/02; VER-CTX-004-01              | Published failure retains work/ownership; current feedback context; changed expected-list migration and safe manual return                      | Primary foundation P5; full CI/maintenance session lifecycle P8; cleanup/retry P10; realistic levels retained |

## Checks and completion

P7-R0 inventories reusable tests: `tests/task-session-dispatch.test.ts`,
`tests/p1-production-lifecycle.integration.test.ts`, feedback ledger/round suites,
`tests/run-task-session-feedback-cycle-attachments.test.ts`, queue/ownership suites.
Create named concurrency/capacity fixtures and exact commands in the launch manifest;
do not claim that current sequential B-publication tests prove simultaneous writers
or FCFS. Run focused cases, `yarn validate`, and authorized realistic feedback/reply
observations at specified levels.

Observe request/acceptance ledgers, process intervals, generation tokens, card state,
remote refs and queue/slot records over multiple polls. Full startup, unsupported
schema and shutdown regression obligations apply to changed state. Current owned
manifest evidence and final integration review must pass; later-owned execution and
cleanup remain explicitly assigned, not silently imported or claimed complete.
