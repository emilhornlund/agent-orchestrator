# P10 execution packet — terminal artifacts, cleanup and deliberate retry

## Entry and boundary

Use [phase execution](phase-execution.md). Status: **packet prepared; readiness not
executed**. Pin P7/P8/P9 terminal fencing, publication and refinement handoff contracts.
Earlier user-closed milestones remain closed; relevant carryovers receive explicit
prerequisite/owned/deferred/release dispositions. Safety defects affecting deletion or
new claims cannot be ignored as historical context.

Objective: verified workflow outcomes, safe attributable cleanup/archive, and a fresh
deliberately queued attempt without losing prior code or diagnostics. Non-goals:
automatic merge, force-push, resurrecting closed PR branches, implicit failure retry,
or deleting unknown/unsafe work to make the project appear idle.

## Readiness contracts

- P10-R0: R-BASE/R-RUNNER; enumerate terminal routes and all claim-release callers.
- P10-R1: [R-UPGRADE](phase-readiness.md): finite supported application/schema/
  layout cohort and actual prior writer artifacts, not invented current records only.
- P10-R2: [R-RESOURCE/R-LIVE](phase-readiness.md): closed-PR accessibility and
  remote-deletion semantics demonstrated in disposable repositories.
- P10-R3: resource manifest and preservation proof cover common Git directory,
  canonical owned path, expected refs/commit ancestry, dirty/staged/ignored setup
  output, local-only commits and external artifacts. Unknown remains preserved.

Write one terminal-obligation table before implementation. Distinguish required
workflow effects, already dispatched uncertain mutations, notification-only uncertainty,
cleanup safely deferred, canonical task release and ongoing host-instance exclusion.
Notification uncertainty cannot undo success or hold terminal task release hostage.
Cleanup deferral may permit a new attempt only after noninterference and preservation
are proved. Task pointers, queue completion and registry release must remain recoverable
if the process stops between any two writes.

An explicit requeue archives the reconciled prior identity and creates distinct
resources from the latest accepted default branch and current card/attachments.
Preserved unfinished work is not a starting implementation. Supported old records
without enough provenance are not silently deleted or assumed safe.

## Ordered vertical tasks

| ID     | One observable result                                                 | Decisive verification                                                                                            |
| ------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| P10-T1 | Required terminal effects precede active-task release                 | Merged Done, unmerged Backlog, pre-PR Failed, refinement Backlog; delayed readback and uncertain mutation        |
| P10-T2 | Merged owned resource cleanup is idempotent and safe                  | Common-dir/path/branch proof; already absent resource/remote deletion; dirty or local-only work preserved        |
| P10-T3 | Closed unmerged work remains accessible before local removal          | Real PR accessibility check; unavailable history/ref refuses deletion; no branch recreation                      |
| P10-T4 | Unsafe cleanup defers without discarding work                         | Manifest of preserved setup exclusions/unshipped commits; noninterference proof before any claim release         |
| P10-T5 | Archived attempt and fresh resources hand off recoverably             | Crash at archive/registry/attempt/worktree/session creation boundaries; no dual writer or old-code inheritance   |
| P10-T6 | Explicit failed-card retry starts clean from current default          | Old logs/bytes retained, new branch/worktree/session identity, unchanged Failed card never retries automatically |
| P10-T7 | Explicit closed-PR retry uses current task not rejected code          | Updated default/card/attachments, prior PR optional context only, preserved old history                          |
| P10-T8 | Every terminal notification route stays truthful and nonblocking      | Failed/refinement/PR events as applicable, actual links/draft info, outbox acceptance uncertainty separate       |
| P10-V  | Terminal/retry lifecycle composes across supported old/current states | Real Git/processes and canonical claims; no internal-file edits required for normal retry                        |

## Criterion/variant ownership

| Requirements / ACs                                                            | Canonical scenarios                           | P10-owned evidence                                                                                                | Remaining owner                                                                                 |
| ----------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| REQ-TR-001 AC1–AC3; REQ-TR-002 AC1–AC3; REQ-TR-003 AC1–AC3                    | VER-TR-001-01; VER-TR-002-01; VER-TR-003-01   | Verified terminal/readback, meaningful comments, preserved failure and explicit fresh retry                       | P11 complete realistic release lifecycle; earlier PR/feedback fences reused                     |
| REQ-GIT-003 AC1–AC3; REQ-GIT-004 AC1–AC4                                      | VER-GIT-003-01; VER-GIT-004-01                | Provenance, dirty/local-only negative controls, repeating cleanup and already-deleted remote branch               | Live provider variants required by scenario references, final environment composition P11       |
| REQ-GIT-005 AC1–AC3; REQ-GIT-006 AC1–AC4                                      | VER-GIT-005-01; VER-GIT-006-01                | Closed-PR preservation and clean deliberate retry, including required realistic accessibility evidence            | P11 full supported upgrade/deployment qualification                                             |
| REQ-SCH-001 AC1–AC3; terminal portions REQ-PR-008 AC3–AC5 and REQ-REF-005 AC4 | VER-SCH-001-01; VER-PR-008-02; VER-REF-005-01 | Final synchronization/resource handoff before next claim; integrate earlier active-operation cancellation/fencing | P7/P8 observe/fence their work; P9 owns full refined field result                               |
| REQ-CTX-002 AC3; REQ-IMP-005 AC3                                              | VER-CTX-002-01; VER-IMP-005-01                | Revised task explicitly queued into fresh clean context/base after earlier clarification/no-output failure        | P5/P6 decision/failure evidence, R-A2 human assessment and P11 realistic qualification retained |
| REQ-NOT-001/002, terminal-route contributions                                 | VER-NOT-001-01; VER-NOT-002-01                | Supported terminal event content/dedup/nonblocking uncertain delivery; use only existing canonical scenario IDs   | P4 transport/outbox foundations; P11 all-event realistic release evidence                       |
| REQ-REC-005 AC2–AC4, touched upgrade contribution                             | VER-REC-005-02                                | Supported actual prior/current archive/retry migration, interrupted/corrupt/unsupported preservation              | P11 full frozen release cohort/local-container matrix                                           |

## Checks and completion

Inventory actual `tests/task-session-terminal-pr.test.ts`,
`tests/task-session-terminal-failure-recovery.test.ts`, `tests/cleanup-worktree.test.ts`,
ownership/run-store/migration suites and real-Git helpers. Name missing archival/
fresh-attempt cases and commands at readiness. Run focused checks and `yarn validate`
through the authorized runner.

Observe independent service state, accessible commits, local/remote refs, byte hashes,
artifact provenance and next-claim timing. Tests must prove preservation of clean
unshipped commits as well as dirty files. Required realistic closed-history and
terminal-provider observations need explicit authorization, not a mock response.
No cleanup success from absence when a read was unavailable. Stop after the frozen
P10-owned matrix and integration gate; P11 handles final release qualification.
