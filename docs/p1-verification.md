# P1-T4 verification record (scoped evidence; not phase closure)

Requirements in `requirements.md`, acceptance criteria in `specification.md`, and scenario oracles in `verification.md` remain authoritative. This records P1-T4's tests and the observed behavior of the current working tree; it does not certify the full requirements or all P1 policy contracts. The historical [implementation audit matrix and totals](implementation-audit.md#requirement-coverage-matrix) reports 82 requirements / 305 criteria at audit revision `7132b33`. P1 evidence below is an overlay only and does not update or recertify any of those statuses.

## Execution identity and boundary

- Date: 2026-11-05. Base/source revision: `8fc76e7`; the tests and runtime under test were uncommitted working-tree changes (T4). No resulting commit/revision is known or implied here.
- Environment: Linux x86_64, Node `v24.18.0`, Yarn `1.22.22`, Vitest `v5.0.5`; dependencies are those installed from the lockfile.
- `package.json` defines `test:p1` as five Vitest files: the stateful harness, the production lifecycle, real-Git maintenance, task-session dispatch, and terminal-PR regression tests.
- Test adapters are offline substitutes; no live Trello, GitHub, or OpenCode service, production resource, or production secret was used. The composed lifecycle creates a temporary source checkout, worktree root, and bare Git remote, uses an allowlisted process environment, isolated HOME/Git configuration and local child commands. This is not a claim of OS-enforced network isolation or a general sandbox for arbitrary child processes.
- The lifecycle invokes production `pollProject` and production orchestration/Git logic, while Trello/GitHub/OpenCode boundaries are fixture adapters. It is not a real-service or deployed/container run.

## Executed evidence

`yarn test:p1` on the working tree above: **5 files / 27 tests passed**. Within those files, the three `pollProject` production-lifecycle cases exercise:

1. Normal PR publication, open-PR occupancy, approval without completion, human merge to `Done`, and next-task claim only on a subsequent poll after terminal observation.
2. Failed validation, draft publication, human close without merge to `Backlog` with an explanatory comment, and the same terminal-observation/next-claim boundary.
3. GitHub accepts PR creation but the response is lost; a subsequent poll with reconstructed clients finds a PR but cannot establish persisted identity, moves the task to `attention-required`, preserves the original PR/remote head/worktree/task record, and excludes the next card. This is an executed **defect characterization**, not successful recovery: there is no product recovery path demonstrated, no second create is issued, and no successful production recovery is claimed.

The two successful terminal variants independently check source checkout head/branch/status/index/tracked content hashes remain at baseline, the pushed task head contains expected content and exactly one commit from the baseline, no force-push/rebase or orchestrator merge dispatch occurred, PR identity/effect count, actor attribution in the fixture ledger, Trello readbacks/comments, and ordering relative to the next claim. The acknowledgement-loss case separately asserts original remote content and PR are retained and next is not claimed. Do not generalize these checks to every product path or external service.

The same focused command also runs the harness and existing tests. The harness has 10 tests for independent copied snapshots/history, accepted-without-response state and service-state restore, deterministic reject/timeout/missing/delay controls, duplicate/concurrent PR effects, bounded barriers and their positions, late acceptance after a negative read, whole-ledger forbidden-action and duplicate-effect negative controls, real temporary Git/source/worktree/bare-remote operations, and actual child process success/failure/timeout/termination. Actual Git argv is inspected in the composed lifecycle and recorded/checked in harness fixtures. A separate fixture child process is killed/reaped and its independently durable checkpoint read afterward; this is a process-fixture characterization, **not** an OS-level application restart. It does not establish universal lifecycle ledger capture, every fault position on every production route, or comprehensive external read-delay/recovery behavior.

Three runtime corrections are included in the T4 working-tree evidence, with regression coverage: an open active Human Review task occupies its project and blocks a new claim; an empty eligible Ready set does not claim queued work (including a future-dated restored event); and the coordinator returns after observing a terminal outcome rather than claiming the next card in that same poll. These are scoped production coordinator corrections, not broad recovery or scheduler completion.

## P1 completion matrix and scenario status

“Core P1 obligation” here means the bounded no-merge/no-unsafe-Git guardrails and the described lifecycle cases, not every acceptance criterion in the linked requirement or scenario. `Partial` is intentionally retained wherever the prescribed scenario level, variants, or independent external evidence are not all met.

| Area / scenario                                                  | P1 evidence in this run                                                                                                                                                                                                           | Status / remaining boundary                                                                                                                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Human owns PR outcome; `VER-PR-008-01`, `REQ-PR-008`             | Normal and draft lifecycle through `pollProject`; approval leaves PR open; human merge and close are observed; destination readbacks and next-card ordering checked; orchestrator merge forbidden.                                | **Core cases exercised; scenario Partial.** Only the listed fixture-adapter paths; no real-service run, all delayed-read/event-precedence variants, or universal terminal/recovery coverage. |
| Published history guardrail; `VER-GIT-001-01`, `REQ-GIT-001 AC3` | Real local source/worktree/bare remote in lifecycle; source baseline preserved; expected remote content/one commit; actual Git argv assertions reject force options and rebase; separate existing maintenance preservation suite. | **Guardrail subset exercised; scenario Partial.** Does not prove all routes, all remote interleavings, or full requirement coverage.                                                         |
| Maintenance refusal; `VER-MNT-002-01`, `REQ-MNT-002`             | Focused command includes real-Git maintenance tests for preservation/refusal and no unsafe published rewrite.                                                                                                                     | **Guardrail subset exercised; scenario Partial.** Additive target merge, ordinary publication, conflict resolution, and full maintenance workflow remain deferred (P8).                      |
| Test lifecycle evidence; `VER-TST-001-01`, `REQ-TST-001`         | Two successful terminal lifecycle variants and one accepted-create acknowledgement-loss defect characterization through production `pollProject`.                                                                                 | **Partial.** No realistic/live lifecycle; only the named composed paths and fixture boundaries.                                                                                              |
| Offline harness/fault evidence; `VER-TST-002-01`, `REQ-TST-002`  | Stateful service fixture, independent observer, faults, barriers, snapshots, negative controls, actual local Git and child-process fixture tests.                                                                                 | **Partial.** Does not prove OS-enforced network isolation, full fault matrix bound to all production routes, delayed terminal read/recovery, or actual application OS restart.               |
| Status/evidence inventory; `VER-TST-003-01`, `REQ-TST-003`       | This record distinguishes tested subset, defect characterization, and omitted evidence; links historic audit without changing it.                                                                                                 | **Partial.** No extracted complete criterion/variant matrix or P11-level closure.                                                                                                            |

Across these six verification scenarios, none is represented as fully passed. “Core cases exercised” does not change the scenario-level Partial status.

## Runtime defect and known gaps

The first divergence in the accepted-create/acknowledgement-loss path is after the GitHub fixture records accepted PR creation but before the create response is returned: production has no persisted PR identity to reconcile. A fresh `pollProject` call observes that a PR exists, refuses to guess ownership, and leaves the task `attention-required`; the original PR and pushed content remain, and no duplicate create or next-card claim occurs. The executed test proves safe preservation/blocking for that path only. It does **not** demonstrate successful recovery, identity repair, or a product-level restart protocol. This wider recovery defect is outside the bounded P1 guardrail/lifecycle completion claimed here and remains unresolved for its assigned recovery work; it must not be described as a product pass.

Existing audit gaps F1/F3/F4/F13 are not fully closed: advisory gating changes, complete terminal precedence/cancellation, comprehensive maintenance/cleanup/retry proof, and live/deployed or realistic agent workflows are not established by this subset. The P1 policy inventory and audit should be read with their historical labels. No P2 work is claimed as started. Nothing here certifies the entire architecture or upgrades the historical 82/305 inventory.

## Commands and observed results

Commands were run on 2026-11-05 against the working tree described above:

```sh
yarn test:p1
# 5 files passed; 27 tests passed
yarn validate
# lint, format:check, typecheck passed; 119 files passed; 1,274 tests passed
```

These are implementer-observed results. Final validation of the exact resulting documentation tree remains for the supervisor; these observations do not imply a later revision or commit.

## Historical assertion inventory

P1-T2/T3 replaced the prior auto-merge and published rewrite/leased-push assertions with no-merge/refusal/preservation guardrails. The changes are present at source base `8fc76e7`; they are historical context, not changes made by this T4 documentation update. T4 adds lifecycle/harness evidence and the three bounded coordinator corrections above. It does not relax unrelated assertions or claim successful recovery for the accepted-but-unacknowledged PR defect.
