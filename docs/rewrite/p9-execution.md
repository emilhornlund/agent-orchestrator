# P9 — recoverable read-only refinement

Temporary implementation guide. Follow [delivery workflow](phase-execution.md).
Read REQ-REF-001–005, REQ-ENV-002, REQ-CTX-001/003 and refinement contributions to
REQ-WF-001 and REQ-SCH-001. Plan small integrated tasks with caller/state handling.
P9 can follow P6 independently of P7/P8. Reuse P5 setup/context and P4 mutation
reconciliation. Implement refinement orchestration here; the runtime refinement
activity itself must not edit repository code. Automatic card splitting/creation
and P10 historical cleanup/retry are outside this scope.

## Implementation order and contracts

1. Enforce read-only agent access after independently attributed setup. Put result
   artifacts outside the repository. Protect tracked, ignored/untracked content,
   index, HEAD and refs; clean Git status alone is insufficient.
2. Support interrupted old refinement records without treating agent changes as
   setup or deleting unknown artifacts. Preserve ambiguity when baseline/result
   provenance is missing.
3. Validate the complete classification/title/description result before any card
   content mutation. Use distinct grounded templates and current attachments;
   bound correction of invalid results with existing policy.
4. Persist original fields, intended complete values and logical mutation identities
   before writes. Record verified own writes and human/history observations.
5. Compare before writing and inspect supported history/readback afterward. Detect
   edits between final read and write, including on restart/compensation. Use only
   Trello Free functionality; unavailable attribution is not proof nothing changed.
6. Reconcile partial updates by completing safely or compensating only attributable
   own writes. Preserve human values and pause on conflicts/unknown acceptance.
   Never claim atomicity or blindly roll back over human edits.
7. Verify complete fields and Backlog before releasing the attempt. Add one concise
   type/duration comment and optional nonblocking notification; do not duplicate
   description content or release on assumed external success.

## Starting points and checks

Current implementation: T1 confines refinement through the existing Bubblewrap
dispatch, with a read-only task worktree/Git metadata and a separately writable
external result directory. Setup-free new attempts persist an inventory too;
older setup-free records lacking that inventory are fenced rather than rebased
onto potentially agent-modified files. Repository-local legacy results remain
preserved and are not reused. Remaining work is bounded complete-result correction,
history-aware field reconciliation and verified completion/release.

Inspect `src/refinement/run-refinement-card.ts`, `run-refinement.ts`,
`run-refinement-setup.ts`, `refinement-operation.ts`, `refinement-result.ts`,
`refinement-mutation-snapshot.ts`, `finalize-refinement.ts`, prompts and workflow
mutation callers. Prepare concrete current-state guidance before implementation.

Reuse `tests/refinement-setup-recovery.integration.test.ts`,
`tests/run-refinement-card-workflow.test.ts`, `tests/run-refinement.test.ts` and
mutation/finalization suites. Cover read-only enforcement, invalid complete results,
partial updates/restart and human-edit races with stateful substitutes and real
local filesystem/Git effects. Follow the delivery workflow for focused task reviews,
small corrections, authorized checkpoints, final integration review and final
`yarn validate`; no live semantic qualification or evidence archive prerequisite.
