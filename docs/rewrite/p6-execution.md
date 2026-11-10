# P6 — advisory implementation and truthful publication

Temporary implementation guide. Use the [delivery workflow](phase-execution.md).
T1–T5 are implemented. T6–T9 publication/isolation changes and the T10 readiness
checkpoint are recorded in [current progress](phase-status.md). Isolation startup
integration is implemented; finish final P6 integration verification and validation.
Do not recreate readiness, manifest, live-qualification or evidence work.

## Product target

Read relevant specification sections: REQ-PR-001–004/007, REQ-IMP-001/003/005,
REQ-VAL-001–005 and REQ-CTX-002/003. Include the initial-workflow contributions to
REQ-GIT-001/002, REQ-ENV-002 and REQ-NOT-001/002 where publication/setup changes touch
them. Read the actual criteria; this summary does not replace them.
The [P6 decisions](p6-decisions.md) are approved;
do not ask for them again. Safe meaningful output is published despite adverse
advice/checks, with truthful draft status and reporting. A genuinely unrecoverable
primary execution or unsafe Git state is different from adverse quality advice.

## Implementation order

1. **T2:** attempt planning and separate plan review before edits, but do not let a
   negative, malformed, unavailable or crashed advisory result veto implementation.
2. **T3:** validation improvement has its own persisted maximum. Charge before
   dispatch, compare exact content, stop on no-op/early finish/limit; restart must
   not reset the budget or repeat unchanged work.
3. **T4–T5:** separate implementation review is advisory. Deliver findings to the
   primary agent for material-issue dispositions. Use a distinct persisted review
   improvement budget with the same no-op/early-finish/restart rules. Preserve the
   original operation/prompt; do not create cross-cycle retry loops.
4. **T6:** enforce source-checkout isolation at writable dispatch, then create one
   descriptive initial commit containing only task-relevant output. Preserve setup
   exclusions across all publishers. Reconcile an uncertain commit instead of
   blindly repeating it; never manufacture changes merely to create a commit.
5. **T7–T8:** select normal/draft from current recorded checks and material issues,
   not AI approval. Use complete purpose/changes/checks/issues/task-link fallback
   descriptions, preserve human text, verify Human Review only after publication,
   and reuse durable deduplicated notification/publication mechanisms.
6. **T9–T10:** infer what the available context supports; essential clarification or
   no meaningful output produces an actionable verified failure with work preserved.
   No implicit fresh retry. Current addressed readiness can promote the same PR;
   stale, uncertain or unresolved evidence cannot.

## Starting code and integration pitfalls

Start with `src/orchestrator/run-task-session-workflow.ts`, the planning/review/
validation-repair modules under `src/task-session/`, `initial-publication.ts`,
`publish-card.ts`, and `src/opencode/opencode-client.ts`. Inspect shared schemas,
prompts and existing-PR feedback callers before changing common contracts.
Persist primary/advisory/outage/unknown outcomes truthfully across result/ledger gaps.
Keep optional quality outcomes from T1 intact, including skipped and uncertain.

Writable OpenCode dispatch now wraps the actual spawn boundary using Bubblewrap;
cwd or prompt instructions alone are insufficient. Startup probes namespace support;
local/container installation guidance is in the product configuration documentation.
Keep common Git metadata and orchestrator
state/logs outside the agent's writable mounts. Scope model config/auth reads and
OpenCode writable cache/session state explicitly. Do not copy the experiment's broad
read-only host mount or disabled SELinux labeling into a production profile blindly.
Preserve cancellation and unknown-descendant fencing; no unsafe redispatch.

## Focused checks and finish

Reuse `tests/initial-publication.integration.test.ts`,
`tests/publish-task-session-card.test.ts`, implementation/review/validation-repair
suites and `tests/task-session-dispatch.test.ts`. Cover changed production routes,
adverse advice, bounded/no-op/restarted improvement, truthful publication, isolation
and relevant uncertain-write recovery. Use real local Git/processes where needed;
no live-service acceptance gate. Follow the delivery workflow for focused task
reviews, small corrections, authorized local checkpoints and final integration review.
Run final `yarn validate` and update progress briefly. No commits without authorization.

P7 observation/capacity/feedback, P8 CI/maintenance, P9 refinement and P10 fresh retries
are later work; preserve their existing safe callers without implementing them here.
