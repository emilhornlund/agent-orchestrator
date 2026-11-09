# P9 execution packet — recoverable, read-only refinement

## Entry and boundary

Use [phase execution](phase-execution.md). Status: **packet prepared; readiness not
executed**. P9 may follow P6 independently of P7/P8, but never introduce another
writer for a project. Pin P5 setup/artifact evidence and P4 mutation reconciliation.

Objective: a grounded refinement result, no agent repository writes, and recoverable
human-edit-aware complete card updates. Non-goals: implementing code, automatic card
splitting/creation, treating Trello updates as atomic, or P10 historical cleanup and
clean deliberate retry. Verified refinement Backlog and active-claim release belong
here; unsafe cleanup may remain preserved under the later artifact contract.

## Readiness tasks and contracts

- P9-R0: R-BASE/R-RUNNER/R-UPGRADE; enumerate old/current refinement records,
  in-worktree result exceptions, setup baselines and finalization mutation paths.
- P9-R1: [R-HISTORY](phase-readiness.md), an authorized Trello Free history/readback
  probe before designing attributable write/compensation assumptions.
- P9-R2: [R-A2-P9/R-LIVE](phase-readiness.md): representative templates and supported
  attachments/limits, grounded/scope fixtures and independent assessment arranged.
- P9-R3: demonstrate the read-only execution boundary and external result channel,
  including ignored/untracked effects, HEAD/index/refs and result-file ownership.

Before field writes, persist originals, intended complete result, known orchestrator
writes and human/history observations. Define allowed state transitions and the
evidence needed to complete, safely compensate, wait or request operator resolution.
Unavailable history/ambiguous acceptance is not proof that fields were untouched.
Never overwrite a detected human value knowingly; inspect readback/history after a
write to detect the specified read/write race. No unsupported atomicity guarantee.

Setup effects are independently attributed; the refinement baseline is the verified
post-setup state. Move the legacy result exception outside the repository without
laundering interrupted agent changes into setup or deleting unknown result artifacts.
Parser correction is bounded by existing approved policy; invalid output changes no
card fields until the complete result validates.

## Ordered vertical tasks

| ID    | One observable result                                           | Decisive verification                                                                                                |
| ----- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| P9-T1 | Refinement result is external and read-only boundary enforced   | Attempted source/ignored/commit/ref/index writes fail or remain detected; setup baseline remains independent         |
| P9-T2 | Old active refinement resumes with attributable baseline/output | Compatible old records and interrupted output handoff; uncertain provenance preserves blockage                       |
| P9-T3 | Complete result validates before any content mutation           | Invalid/incomplete classification/title/description bounded correction; no partial field writes                      |
| P9-T4 | Original/intended field journal precedes dispatch               | Intent/acceptance/response/completion crash barriers, stable logical mutation identity                               |
| P9-T5 | Detected human field edits pause further writes                 | Untouched/already-written/uncertain-write fields; actual history and unavailable-history negative controls           |
| P9-T6 | Recoverable partial update completes or safely compensates      | Exact verified fields, no blind rollback, restart and attributable-human preservation                                |
| P9-T7 | Postwrite read/history catches supported concurrent races       | Human edit between final read and accepted write in initial/recovery/compensation variants                           |
| P9-T8 | Verified full result returns once to Backlog and releases claim | Concise type/duration comment, optional notification, delayed readback, no next claim before evidence                |
| P9-V  | Grounding/scope/template and recovery observations compose      | Representative Feature/Improvement/Bug tasks, distinct attachments, independent rubric and required realistic checks |

## Criterion/variant ownership

| Requirements / ACs                                            | Canonical scenarios                            | P9-owned evidence                                                                                                                | Remaining owner                                                                              |
| ------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| REQ-REF-001 AC1–AC3; REQ-REF-002 AC1–AC3; REQ-REF-003 AC1–AC4 | VER-REF-001-01; VER-REF-002-01; VER-REF-003-01 | Grounded read-only analysis, approved adaptable templates, scope/no automatic split; required realistic human/model assessment   | P11 complete release environment/lifecycle                                                   |
| REQ-REF-004 AC1–AC6                                           | VER-REF-004-01; VER-REF-004-02                 | Complete validation, journal/recovery, human conflict and read/write race variants; real history/race level required             | P10 deliberate retry after verified failure; no missing race evidence passed by parser tests |
| REQ-REF-005 AC1–AC4                                           | VER-REF-005-01                                 | Full fields, Backlog, concise duration/type comment and verified active-task release; simulated lifecycle as specified           | P10 historical artifact cleanup/retry; P11 complete realistic lifecycle                      |
| REQ-ENV-002 AC1–AC7, refinement slice                         | VER-ENV-002-01                                 | Setup ordering/attribution/skip/failure recovery, refinement read-only after setup                                               | Implementation scope P5/P6; complete environment qualification P11                           |
| REQ-CTX-001 AC1–AC3; REQ-CTX-003 AC1–AC3                      | VER-CTX-001-01; VER-CTX-003-01                 | Current supported attachment access and authorized field/comment mutation in refinement; non-refinement negative controls reused | Other activities P6/P7/P8; P11 complete integration                                          |
| REQ-WF-001 and REQ-SCH-001 refinement contribution            | VER-WF-001-01/02/03; VER-SCH-001-01            | No success/release before verified full result, no duplicate ambiguous writes, no competing claim                                | Other workflows retain their owners; P10 terminal composition                                |

## Checks and completion

Read existing `tests/refinement-setup-recovery.integration.test.ts`,
`tests/run-refinement-card-workflow.test.ts`, `tests/run-refinement.test.ts`,
`tests/workflow-mutations.integration.test.ts` and result/finalization suites.
At P9-R0 create exact runnable read-only/card-race tests and manifest commands.
Run focused checks and runner-owned `yarn validate`.

Observe original/current fields, available action history, append-only accepted
effects, repo/file/index/ref identities and claim timing. Use controlled independent
services for routine races and authorized real Trello Free/model observations where
required. An external result JSON alone does not establish grounding, read-only
enforcement or conflict-safe finalization. Required levels cannot be silently deferred.
