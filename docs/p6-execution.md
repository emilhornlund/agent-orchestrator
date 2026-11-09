# P6 execution packet — advisory initial implementation and publication

## Entry and boundary

Use [phase execution](phase-execution.md). Status: **four user decisions approved;
engineering readiness under assessment, implementation not started**. See the
[approved policy/rubric/cohort/live scope](p6-decisions.md). Pin the actual base and authorized Git actions at
launch. The P5 milestone is user-closed; use [its carryovers](phase-status.md)
without reopening it or treating historical missing evidence as passed.

Objective: initial implementation can safely publish meaningful work despite
adverse or unavailable advice, with accurate normal/draft state and reporting.
No automatic merge, force-push, source-checkout writes, unrelated setup commits,
or publication of genuinely unrecoverable interrupted primary work.

Non-goals: new feedback classification/concurrent observation/capacity (P7), new
CI episodes or maintenance (P8), refinement compensation (P9), fresh retries and
historical cleanup (P10). Shared changes must preserve their existing safe routes.

## Readiness tasks

| ID    | Deliverable                                           | Done when / dependent work                                                                                                                                                                                                                                                                  |
| ----- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P6-R0 | Baseline, caller inventory and finite launch manifest | Record initial/existing-PR publishers, primary/advisory/reconstruction roles, task schemas, regression commands and every applicable variant below; [R-BASE/R-UPGRADE/R-RUNNER](phase-readiness.md) assessed                                                                                |
| P6-R1 | Source-checkout protection feasibility                | [R-SOURCE](phase-readiness.md) has a runnable negative-write proof and supported local/container mechanism before writable dispatch changes                                                                                                                                                 |
| P6-R2 | Approved budget/rubric mapped to executable evidence  | User approval is recorded in [P6 decisions](p6-decisions.md); finish actual code/accounting mapping and concrete fixtures/assessment. Do not request the same policy approval again.                                                                                                        |
| P6-R3 | C2 impact/feasibility disposition                     | [R-C2](phase-readiness.md) investigated; identify which tasks rely on automatic orphan closure. Preserve unknown-state fence. Independent advice/publication tasks may proceed without claiming that recovery works.                                                                        |
| P6-R4 | Authorized realistic gate resource manifest           | Isolated P6 scope is authorized by D6-LIVE. Record bounded calls/effects, prove resource access and schedule owned observations; missing resources are provisioning results, not missing permission. Do not silently replace required live evidence with an implementation-only acceptance. |

Technical readiness tasks are engineering work, not a reason to wait for general
user approval. Ask only for demonstrated product/support/resource choices.

## Required contracts before coding

- Planning and independent reviews are attempted advice. A verdict is not permission
  to implement or publish. The agent owns semantic material-issue dispositions.
- Validation and coverage are independently optional; absence is `skipped`, never
  `passed`. Readiness follows REQ-VAL-005, including skipped/uncertain disclosure,
  without an AI approval requirement. Do not reopen settled A3 policy.
- Validation/review improvement maxima are distinct; no-op or early finish ends
  that cycle. Define content comparison identity, charge point and restart behavior.
- [D6-RECOVERY](p6-decisions.md#d6-recovery--counted-unit-and-limit) and
  [D6-RUBRIC](p6-decisions.md#d6-rubric--representative-p6-acceptance-judgments)
  are the approved policy and representative semantic oracles. Turn them into
  concrete fixtures; do not treat their approval as executed semantic evidence.
- Primary crash, advisory failure, structured dependency outage, ambiguous execution,
  and unsafe publication are distinct typed outcomes. Reuse existing recovery policy;
  no new crash limit. Preserve durable classification across result/ledger gaps.
- Initial commit scope includes only relevant setup output. Every correction
  publisher must still preserve historical excluded setup paths. A new helper
  contract must account for all publishers before callers are changed.
- PR description fallback contains observed purpose/changes/checks/issues/task link.
  Managed content preserves human text; no fabricated validation or semantic fix claim.

## Ordered vertical tasks

Split only at safe integration boundaries; each task includes its production caller
and decisive regression. Do not delegate this whole list in one request.

| ID     | One observable result                                         | Decisive verification                                                                                              |
| ------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| P6-T1  | Optional quality commands produce truthful outcomes           | Neither/either/both configured, actual command exits and skipped reporting; no agent-claimed pass                  |
| P6-T2  | Planning/plan review cannot veto initial implementation       | Negative/malformed/unavailable/crashed advice with bounded attempt, followed by primary dispatch                   |
| P6-T3  | Validation improvement stops at no-op/early finish/limit      | Distinct persisted budget, exact content comparison, restart at exhaustion, no unchanged repeat                    |
| P6-T4  | Independent implementation review is advisory                 | Separate review session and findings/disposition input; negative/unusable advice cannot cause quality-only failure |
| P6-T5  | Review improvement stops at no-op/early finish/limit          | Persisted distinct budget and original prompt/operation on restart; no extra review of unchanged work              |
| P6-T6  | Safe initial task output becomes one descriptive commit       | Real Git; scope proof, source protection and uncertain commit recovery; no artificial no-output commit             |
| P6-T7  | Recorded evidence selects truthful normal/draft state         | Passing/failed/skipped/uncertain/material-unresolved cases; same published PR and verified Human Review            |
| P6-T8  | Description/fallback and initial notification reflect reality | Managed human text preserved, generator crash/malformed output, actual draft flag and deduplicated P4 event        |
| P6-T9  | Evidence-backed clarification/no-output uses verified failure | Required context examined, actionable comment, destination readback, work preserved; no implicit fresh retry       |
| P6-T10 | Addressed initial readiness evidence permits draft-to-ready   | Existing PR identity, correct current evidence, P4 mutation/restart checks; no AI approval token                   |
| P6-V   | Owned variants compose at application boundary                | Actual Git/processes and stateful services; adverse-quality draft path and passing path with crash barriers        |

## Criterion/variant ownership

This table partitions existing scenarios; the launch manifest expands every owned
row into exact named variants/commands before its dependent task. No row is executed
by this document. Required levels remain those of [verification.md](verification.md).

| Requirements / AC contribution                 | Canonical scenario                    | P6-owned observation                                                                                                               | Remaining owner                                                                                         |
| ---------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| REQ-PR-001 AC1–AC3; REQ-PR-002 AC1–AC4         | VER-PR-001-01; VER-PR-002-01          | Initial adverse advice/checks, no-op, early finish and exhaustion through publication; integration + simulated E2E where specified | P7/P8 apply policy to their corrections; P11 complete realistic lifecycle                               |
| REQ-PR-003 AC1/AC5; primary AC2/AC3 regression | VER-PR-003-01/02                      | Crash versus quality/outage classification and initial advisory crash publication; preserve primary exception                      | P5 recovery carryovers remain explicit; P7 owns published correction variant 03; P10 clean retry        |
| REQ-PR-004 AC1–AC4; REQ-VAL-005 AC1–AC5        | VER-PR-004-01; VER-VAL-005-01         | Initial/readiness matrix, observed draft metadata and notification; accurate ready update                                          | P7/P8 refresh their operations; P11 realistic complete workflow                                         |
| REQ-PR-007 AC1, initial contribution to AC2    | VER-PR-007-01                         | Initial description/fallback only                                                                                                  | P7 feedback refresh/status, P8 CI/maintenance refresh/status; no full PR-007 pass from initial body     |
| REQ-IMP-001 AC1–AC3; REQ-IMP-003 AC1–AC4       | VER-IMP-001-01; VER-IMP-003-01        | Protected task-specific writes and planning-before-edit without approval; required actual negative boundary tests                  | P11 semantic/live complete lifecycle; approved fixtures needed now for owned semantic claims            |
| REQ-IMP-005 AC1/AC2; REQ-CTX-002 AC1/AC2       | VER-IMP-005-01; VER-CTX-002-01        | No artificial work; evidence-backed no-output/clarification and verified failure                                                   | AC3 fresh attempt/requeue P10; realistic semantic levels require R-A2-P6/R-LIVE, not a parser-only pass |
| REQ-VAL-001–004, all ACs for initial workflow  | VER-VAL-001-01 through VER-VAL-004-01 | Actual optional commands; separate advisory findings; distinct persisted improvement limits and skip/continue behavior             | P7/P8 correction route composition; final whole-product qualification P11                               |
| REQ-CTX-003 AC1–AC3, initial activity slice    | VER-CTX-003-01                        | No card-content mutation/routine comment noise during initial implementation/advice/publication                                    | P7/P8/P9 own their activity variants; P11 composes                                                      |

## Checks, evidence and acceptance

Existing regression entry points: `yarn vitest run tests/initial-publication.integration.test.ts
tests/publish-task-session-card.test.ts tests/run-task-session-implementation.test.ts
tests/run-task-session-review-repairs.test.ts tests/run-task-session-validation-repairs.test.ts
tests/task-session-dispatch.test.ts`. Add named P6 cases to the manifest and a runnable
case selection during P6-R0 using ordinary `yarn test`; do not add milestone-specific
scripts or commands. Existing tests may encode policy being deliberately replaced.
Run `yarn validate` through the designated runner for the final candidate.

Observe real local commits/refs, process exits, session routing, service effects,
PR body/draft and Trello readback—not only callback invocations. Include result-before-
ledger, commit/push/PR acceptance-before-response and card synchronization barriers
for changed routes. Preserve original checkout, excluded setup bytes and existing-PR
correction behavior. Arrange realistic owned semantic/publication observations at
their stated levels; missing evidence remains blocked, not silently assigned away.

P6-owned acceptance requires its frozen manifest and integration review to pass.
It does not require implementing later-owned PR-007 refreshes, P7 capacity, or P10
fresh retry. Record all carryovers and stop at P6; no automatic merge/deployment.
