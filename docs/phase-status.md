# Architecture milestone and carryover ledger

## Current planning boundary

The user closed the P5 delivery milestone and requested publication. Branch
`architecture/p5-recovery-first` was pushed and [PR #218](https://github.com/emilhornlund/agent-orchestrator/pull/218)
was created. P5 is not automatically reopened by future phase launch instructions.
Its historical whole-phase review was FAIL/BLOCKED; closing/publishing the delivery
milestone did not turn incomplete evidence or an unresolved finding into a pass.

Historical source checkpoint: `f8ac2ea`; reviewed source `9f9988a`, followed by the
test-only zombie-oracle correction `b2e73a8`. This planning revision adds no runtime
fix for C2. At P6 launch, pin the actual working/merged base rather than assuming
the PR has merged or that a documentation revision is the tested runtime revision.

## Current and next work

The four [P6 readiness recommendations](p6-decisions.md) are now user-approved.
No additional approval is needed for that rubric, counted-unit policy, support cohort
or the authorized isolated P6 test scope. Engineering feasibility, concrete fixtures,
actual artifact inventory and resource provisioning still require execution.
PR #218 was observed OPEN at `f8ac2ea` during approval recording; do not assume merge.

The [bounded P6 preflight snapshot](p6-preflight.md) records available tooling,
authenticated GitHub access and successful candidate local/container filesystem
checks. Exploration stopped at the user's wrap-up request. Production boundary/C2
proof, actual deployed-version inventory and live provisioning remain engineering
work; these observations are not a full readiness pass.

| Item                          | Status                                                                                      | Owner / next action                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| P5 delivery                   | User closed; PR published                                                                   | Preserve historical evidence; no new P5 task loop                                                                              |
| P6                            | User decisions approved; engineering preflight under assessment, implementation not started | Use [P6 decisions](p6-decisions.md) and [readiness tasks](p6-execution.md); do not report approval as a passed technical proof |
| P7–P11                        | Packets prepared; not started                                                               | Rebase packet assumptions and close due prerequisites at each launch                                                           |
| Product/release qualification | Not established                                                                             | Preserve scenario outcomes and execute P11 qualification when its dependencies exist                                           |

## Carryovers, not hidden prerequisites

| ID         | Finding / remaining evidence                                                                                              | Disposition and owner                                                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CO-C2      | Supervisor loss plus escaped descendants lacks reliable stopped-execution proof                                           | Open engineering feasibility task, [R-C2](phase-readiness.md). P6 readiness must determine which owned paths depend on closure. Existing unknown-state fence stays; no unsafe redispatch. An independent accepted slice may proceed if it does not claim orphan recovery. |
| CO-BUDGET  | Historical A5 counted-unit ambiguity resolved by user                                                                     | [D6-RECOVERY](p6-decisions.md#d6-recovery--counted-unit-and-limit) approves three verified genuine failures with separate outage/reconstruction accounting. Verify code/migration mapping before dependent changes; old wording remains historical, not competing policy. |
| CO-COMPOSE | Full production startup/process evidence/shutdown/inspection/resume and broader monitor/migration variants remain partial | Each receiving packet assigns its touched-path regression; P11 owns complete release composition. Explicitly list any prerequisite subset in that packet's launch manifest. Do not declare the entire requirement passed.                                                 |
| CO-LIVE    | Required realistic evidence remains unexecuted; isolated P6 verification now authorized                                   | [D6-LIVE](p6-decisions.md#d6-live--authorized-isolated-p6-verification) grants the bounded existing-account disposable scope. Provision/verify resources and run required owned observations; do not reclassify historical missing evidence as passed.                    |

## Historical execution evidence

- P5 `yarn validate`: 2,066 tests / 165 files, plus lint/format/typecheck, on the
  retained historical tree. `yarn test:p5`: 579 tests / 39 files after its oracle fix.
- Podman bounded shutdown/upgrade slice: 20 tests / 4 files, before C5/C6. It is
  not a current complete container lifecycle result.
- Exact logs, failed attempts, scopes and limits remain in
  [P5 verification](p5-verification.md) and [P5 progress](p5-progress.md).

Do not recycle these results as validation of later runtime changes. Update this
ledger when the user chooses a milestone or a launched manifest changes status;
historical evidence remains unchanged.
