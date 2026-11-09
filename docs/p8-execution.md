# P8 execution packet — bounded CI episodes and additive maintenance

## Entry and boundary

Use [phase execution](phase-execution.md). Status: **packet prepared; readiness not
executed**. Pin the actual P7 writer/observer/slot contracts and P6 advisory policy.
Preserve operation/session recovery, setup exclusions and human terminal precedence.

Objective: bounded expected-check observation and durable repair episodes; safely
merge target updates into the existing published branch. Non-goals: rewrite history,
force-push, replacement PRs, new semantic policy in the orchestrator, P9 refinement,
or P10 terminal cleanup/retry implementation.

## Readiness and contract tasks

- P8-R0: R-BASE/R-RUNNER/R-UPGRADE; inventory CI expectation, episode, maintenance,
  publisher and status consumers and supported active records.
- P8-R1: [R-A5-CI](phase-readiness.md). Specify supported expected-check sources,
  precedence and discovery failures; observation clock start/end; missing, never-
  registered, queued, stale and rerun results. Bind numeric choices to approved
  policy/existing configuration, not test values.
- P8-R2: R-BUDGET plus semantic new-trigger examples. Strict agent evidence may
  classify a materially new independent failure; polling/new SHA is not that proof.
- P8-R3: prove real-Git merge/push behavior with dirty reviewed exclusions, staged
  state and unshipped commits; design preservation before merge execution.
- P8-R4: R-LIVE authorizes real check discovery, conflict/ancestry and repair
  observations before their required evidence gate.

Episode identity is a durable verified initiating event, never merely a head SHA.
Document charge-before-dispatch, limit, early-finish/no-op stop, same-episode polls,
self-generated commits/reruns/target merges, reset trigger and migration. Expired
observation ends with disclosed uncertainty, not assumed CI success or task failure.

Maintenance records base/remote/local identities and provenance. Existing dirty setup
exclusions are preserved, not blindly staged or discarded. Refuse/reconcile when a
safe additive merge/push cannot be established. A closed PR never authorizes branch
recreation; races after a prior open read still require authoritative reconciliation.

## Ordered vertical tasks

| ID    | One observable result                                        | Decisive verification                                                                                             |
| ----- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| P8-T1 | Expected checks and current-revision results are explicit    | Valid/unknown sources, stale success, absent registration; no false pass                                          |
| P8-T2 | CI observation ends at its durable deadline                  | Never-started/pending forever, restart, disclosure and return to Human Review                                     |
| P8-T3 | One initiating event retains one repair budget               | Persisted charge, changed self-generated SHAs/reruns/polls/restart do not reset                                   |
| P8-T4 | Only verified new work permits a new episode                 | New human request including explicit retry; independent new failure judgment; duplicate/cosmetic trigger rejected |
| P8-T5 | Available CI correction publishes despite adverse advice     | Same session/refreshed attachments, early finish/no-op/exhaustion, same PR and accurate draft/report              |
| P8-T6 | Open PR observation detects maintenance without opt-in       | Approved-open, target advanced/conflict; P7 queue priority remains intact                                         |
| P8-T7 | Target synchronization adds merge history safely             | Real published divergence, existing commit IDs preserved, ordinary push; exclude/preserve unrelated dirty output  |
| P8-T8 | Conflict assistance is bounded and recoverable               | Agent conflict work, timeout/ambiguity, unshipped work, no force/reset/replacement PR                             |
| P8-T9 | CI/maintenance description/status reflects current evidence  | Top status/update/clear, body human text and concurrent edit safeguards                                           |
| P8-V  | CI and maintenance compose with observation/terminal fencing | Enqueued human work, merge/close at edit/prepush/dispatched boundaries, no stale publication                      |

## Criterion/variant ownership

| Requirements / ACs                                                         | Canonical scenarios                            | P8-owned evidence                                                                                                            | Remaining owner                                                                         |
| -------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| REQ-CI-001 AC1–AC3; REQ-CI-002 AC1–AC6                                     | VER-CI-001-01; VER-CI-002-01                   | All declared check/episode/no-op/exhaustion/reset variants; real discovery/status level where specified                      | P11 full realistic lifecycle, not a substitute for P8-owned real discovery              |
| REQ-MNT-001 AC1–AC3; REQ-MNT-002 AC1–AC4                                   | VER-MNT-001-01; VER-MNT-002-01                 | Detection, approved-open, divergent real Git merges, conflict and remote safety; realistic ancestry/identity checks required | P10 cleanup/archival; P11 full release composition                                      |
| REQ-MNT-003 AC1–AC3; REQ-MNT-004 AC1–AC3                                   | VER-MNT-003-01; VER-MNT-004-01                 | Advisory follow-up and activity status in CI/maintenance, success/issues/restart                                             | P7 feedback status and P6 initial-body evidence reused by actual boundary               |
| REQ-GIT-001 AC1–AC3; REQ-GIT-002 AC1–AC3                                   | VER-GIT-001-01; VER-GIT-002-01                 | Maintenance/correction safety and additive history; regression of P6 initial single commit and protected source              | P10 owned cleanup/fresh retry, P11 whole-lifecycle qualification                        |
| REQ-PR-007 AC2/AC3; REQ-HR-006 AC1–AC6 maintenance contribution            | VER-PR-007-01; VER-HR-006-01; VER-PR-008-02    | CI/maintenance refresh and P7 queue/terminal contract integration                                                            | P10 final terminal artifacts; full scenario cannot be inferred from initial publication |
| REQ-IMP-004 lifecycle contribution; REQ-CTX-001/003 activity contributions | VER-IMP-004-01; VER-CTX-001-01; VER-CTX-003-01 | Same primary session/current task and attachments during CI/maintenance; no card title/description mutation                  | P9 attachment/refinement integration, P11 realistic complete continuity                 |

## Verification and exit

Start from `tests/run-task-session-ci-repairs.test.ts`,
`tests/task-session-maintenance-dispatch.test.ts`,
`tests/pr-maintenance-publication.integration.test.ts`,
`tests/task-session-terminal-pr.test.ts` and real-Git helpers. Replace explicitly
incompatible old oracles alongside behavior; retain equivalent failure/preservation
coverage. Create exact episode/deadline/merge test commands in the launch manifest.
Run focused checks and designated `yarn validate`.

Independent observations include remote ancestry/object IDs, attempted push options,
episode counters and initiating-event IDs, request times, PR state/body/draft and
verified Trello transitions. Test multiple polls after exhaustion and actual fresh
process recovery for touched durable records. Required live variants need authorized
resources; scripts alone do not establish provider check/default/actor behavior.
Accept only the frozen owned matrix; no P10 cleanup or new history-rewriting route.
