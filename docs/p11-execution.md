# P11 execution packet — finite lifecycle and release qualification

## Entry and boundary

Use [phase execution](phase-execution.md). Status: **packet prepared; prerequisites
and environments not yet demonstrated**. Pin actual P10 integration and all accepted
carryovers. A published or user-closed phase is not evidence that its outstanding
product criteria passed. P11 does not authorize production rollout or silently waive
an unresolved implementation defect such as unknown orphan liveness.

Objective: demonstrate complete agreed behavior across the supported release matrix
and retire unsafe legacy dispatch only after migration/drain evidence. No speculative
provider framework, permanent live-test service, paid-only integration, unsupported
multi-host coordination, or unrelated refactoring.

## Readiness deliverables before the qualification run

| ID     | Deliverable                                                         | Required outcome                                                                                                                                                           |
| ------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P11-R0 | Actual release candidate, prior artifacts and requirement inventory | All 82 requirement IDs/305 ACs accounted for or an explicitly approved authoritative baseline revision; no count inferred from test names                                  |
| P11-R1 | Finite release manifest                                             | Enumerate every required canonical scenario/variant, supported environment/auth/upgrade cohort, evidence reuse and actual commands; unresolved rows visible                |
| P11-R2 | Decisions closed when needed                                        | [Readiness register](phase-readiness.md) shows earlier A2/A5 prerequisites resolved; explicitly list residual release-only decisions, owners and due tasks                 |
| P11-R3 | Authorized realistic environment                                    | R-LIVE scoped credentials/resources/actions and cost limits; disposable Trello Free/GitHub/OpenCode/email, paths and persistent container volumes; no production resources |
| P11-R4 | Containment, source protection and migration capabilities           | Inherited defects affecting required recovery/safety resolved and demonstrated; no arbitrary PID/age inference or missing original-state provenance                        |
| P11-R5 | Executable offline and live drivers / independent observers         | Actual Git/processes, app startup/polling, append-only substitute ledgers, live readback where required, recording and sanitized evidence archive                          |

Prepare the environment early in the architecture work when earlier owned realistic
gates need it; it cannot be discovered missing only at P11. If a resource is not
authorized, record the exact blocked run and continue independent ready work. Never
claim release qualification without the required realistic levels.

## Release matrix construction

For each canonical scenario, copy its explicit variants and applicable inherited
fault boundaries into the manifest. Attach required levels and local/container
requirements. Select supported actual prior application artifacts; do not invent an
open-ended obligation to every experimental historical commit. Explain unsupported
versions and prove their originals are preserved.

Reuse earlier evidence only if its tested artifact/tree and behavior remain applicable;
rerun changed paths. Shared runs may prove multiple rows by actual assertions. Document
which cross-dimension combinations need full coverage and any justified combination
sampling for additional dimensions; sampling never replaces explicitly required
variants. Missing rows remain failed/blocked/unexecuted, not a growing implicit
“everything else” list. A new product/support requirement changes the authoritative
baseline through explicit user agreement, not a reviewer suggestion.

## Ordered bounded tasks

| ID      | One qualification deliverable                                      | Observation boundary                                                                                                                  |
| ------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| P11-T1  | Passing implementation to normal PR                                | Actual startup, setup/plan/advice/checks, one commit/PR, observed body and Human Review                                               |
| P11-T2  | Adverse advice/checks to truthful draft PR                         | Negative/malformed/unavailable/crashed advice and exhausted/no-op correction disclose facts without veto                              |
| P11-T3  | Human changes and partial correction lifecycle                     | Same PR/additive history, current feedback, unresolved draft/thread ownership, no repeated unchanged work                             |
| P11-T4  | CI episode and additive target synchronization lifecycle           | Expected checks/bounds, stable exhausted budget, real divergent merge ancestry and no force-push                                      |
| P11-T5  | Merge and unmerged closure/fresh retry lifecycles                  | Verified Done/Backlog and preserved artifacts; no next task before reconciliation; explicit retry clean                               |
| P11-T6  | Refinement and clarification/no-output lifecycles                  | Grounded read-only refinement, human-edit races, concise Backlog outcome; evidence-backed failure and fresh requeue                   |
| P11-T7  | Active shutdown/restart and dependency restoration lifecycle       | Production startup/runtime/inspection/resume composition, pending-claim races, same operation/session and no duplicate effects        |
| P11-T8  | Supported upgrade and environment parity                           | Actual prior/current artifacts, interruption/retry/corrupt/unsupported variants, pinned paths/volumes and independent healthy project |
| P11-T9  | Controlled credential/log/notification surfaces                    | Known forms/channel scans, App/PAT isolation, separate process logs and active-safe retention; no universal secret claim              |
| P11-T10 | Legacy dispatch retirement is safe                                 | Supported active records migrated/drained; no contradictory auto-merge/force-push/gated-publication route remains reachable           |
| P11-T11 | Operator/configuration/recovery guidance matches supported release | Normal recovery needs no internal-file editing; supported versions, limitations and safe interventions are actionable                 |
| P11-V   | Final evidence reconciliation and integration review               | Every release-manifest row has assessable evidence at its required level; final exact-tree validation and authorized release handoff  |

Each task is further split at a natural complete scenario boundary if its variants
are too large. Do not delegate the entire matrix to one implementer or turn final
review into an unbounded new audit. Newly demonstrated safety defects still require
correction and affected-scope verification.

## Criterion ownership and execution

- REQ-ENV-001 AC1–AC3: `VER-ENV-001-01`, actual local/container paths, volumes,
  startup/task/terminal/recovery parity, including required realistic observations.
- REQ-TST-001 AC1–AC4: `VER-TST-001-01/02`, complete simulated and realistic
  lifecycle drivers, actual independent endpoints and failure distinctions.
- REQ-TST-002 AC1–AC3: `VER-TST-002-01`, repeatable offline faults with denied live
  access and observable effects, not unit callback-only success.
- REQ-TST-003 AC1–AC4: `VER-TST-003-01`, full criterion/variant record, uniqueness,
  actual outputs, missing-level accounting and realistic baseline evidence.
- REQ-REC-005 AC2–AC4: repeat `VER-REC-005-02` for the frozen actual release cohort;
  other recovery scenarios retain their own criteria and inherited fault variants.
- All preceding domain requirements: preserve canonical Coverage mappings and
  complete the cross-domain lifecycle/environment compositions assigned here by
  P6–P10 packets. No requirement is newly considered passed by document presence.

At readiness, record existing commands and add a reproducible scoped release driver;
do not list a future script as executed. Full `yarn validate` remains necessary but
not sufficient. Use Podman on this host for Docker-compatible checks. Realistic
actions need the R-LIVE manifest; log resource IDs/versions/actors and observations
without credentials. No automatic merge in the application: a separately authorized
human action supplies merge/closure outcomes.

## Exit

Release qualification passes only with all required criteria/variants/levels, no
blocking defect, supported upgrades and environment behavior, independent integration
review, and exact-tree validation. If anything is missing, state its precise status
and next owner/action. A user may close a delivery milestone separately, but that
does not fabricate release evidence or authorize deployment, merge or history rewrite.
