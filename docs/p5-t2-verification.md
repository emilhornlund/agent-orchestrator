# P5 T2 isolated OpenCode verification — historical candidate evidence

> **WIP only: NOT READY FOR DEPLOYMENT; T2/P5 NOT COMPLETE.** The evidence
> below records candidate probes and historical test results, not current
> acceptance or independent-review approval. Independent review found
> unresolved safety defects and invalid oracles. See
> [`p5-remaining-activities.md`](p5-remaining-activities.md) for the ordered
> backlog. No source is represented as having passed independent review.

This opt-in harness makes real model requests. It does not use Trello/GitHub,
does not read application configuration, and does not delete OpenCode sessions.
The fixture repository/worktree and runtime evidence are retained for manual
inspection. Run from the repository with an explicitly provisioned CLI and
model credentials:

```sh
mkdir -p node_modules/.p5-tmp
TMPDIR="$PWD/node_modules/.p5-tmp" P5_T2_MODEL=openai/gpt-6.1-sol \
  P5_T2_VARIANT=high yarn tsx scripts/p5-t2-opencode-verification.ts
```

The model/variant are required arguments, not product defaults. Each real call
has a 120-second bound. The first call captures a new session ID; the second
resumes that exact ID and must reproduce a unique prompt token and attachment
fixture fact. Evidence JSON includes the selected model/variant and execution
IDs. Inspect the returned session metadata and files independently before
making any recovery claim. Do not delete a session unless its exact harness
ownership has been established and deletion is separately authorized.

## Executed probes (2026-11-08)

An earlier probe captured session `ses_e44adcfdbffeSffVgtH4T0IgeL` and made a
second same-session request, but the test oracle searched for a `P5T2_...`
string containing the word “token.” OpenCode's production redactor correctly
redacted that output. Supervisor inspection of export `dc96057a...` independently
confirmed model recall of `P5T2_1794144086982_ISOLATED_FACT` and the blue
lantern number 47. Disposition: **invalid test oracle, not a continuity failure**;
the original failure is preserved in this record. No secrets are reproduced.

Corrected probe: Yarn 1.22.22, OpenCode CLI 1.18.35, explicit model
`openai/gpt-6.1-sol`, variant `high`, launched with `env -i`; fixture uses a
fresh empty `XDG_CONFIG_HOME` and preserves HOME/PATH for CLI authentication.
It passed the harmless phrase/attachment recall test. Session:
`ses_e44abbedaffeuFfRXv1XjW1Rrb`. OpenCode execution IDs:
`4d22d9a2-e86a-4e10-8159-b3c3adce0b93` (initial) and
`9c25ab50-0e65-4821-93aa-cf08999e4418` (resume). Artifact root:
`node_modules/.p5-tmp/p5-t2-AV31qV`; exact response is retained in
`runtime/resume-result.json`. This demonstrates real same-session context
continuity across separate CLI process invocations with an isolated Git
worktree. It is not a parent-process restart test or ledger accounting test.
No session was deleted. The two supervisor-reported sessions
`ses_e44aeb785ffeaYwVuCEO6ajnXG` and `ses_e44b14eb3ffeVJlF0WGNeYToMr` were not
touched.

## Evidence and limits

Generated JSON is intentionally outside source control. A successful result
establishes only a real fresh-session plus same-session context-resumption probe.
It does **not** establish process-restart
reconstruction, task-execution-store primary accounting/replay, lost-session
confirmation/reconstruction, unknown-inspection behavior, or timeout descendant
containment. Those levels require inspection of the durable orchestrator ledger
and dedicated controlled failure scenarios; this script does not emulate them.
Provider errors/unsupported model variants are BLOCKED, never a pass, and must
not trigger blind retries.

## Superseded integrated candidate evidence (2026-11-08; not acceptance)

The A5 policy is three **actual primary executions total** (one initial plus at
most two recoveries), shared default sourced from existing service retry limits;
service-request retries, quality passes, and primary execution charges remain
separate. No configuration key was added. Primary operation accounting is
persisted before actual process dispatch. The fresh-child process-finish /
ledger-CAS gap is now exercised below; T2 still has scenario-matrix gaps and is
not complete or approved.

Candidate commands (temporary files beneath `node_modules/.p5-tmp`):

```sh
TMPDIR="$PWD/node_modules/.p5-tmp" yarn lint:fix
TMPDIR="$PWD/node_modules/.p5-tmp" yarn vitest run \
  tests/primary-task-session.test.ts tests/build-primary-session-context.test.ts \
  tests/reconcile-task-session.test.ts tests/process-runtime.test.ts \
  tests/run-task-session-implementation.test.ts \
  tests/run-task-session-validation-repairs.test.ts \
  tests/run-task-session-review-repairs.test.ts \
  tests/run-task-session-ci-repairs.test.ts \
  tests/run-task-session-feedback-remediation.test.ts \
  tests/run-primary-operation.test.ts tests/primary-operation-ledger.test.ts \
  tests/inspect-primary-operation.test.ts tests/primary-result-artifact.test.ts \
  tests/persist-primary-operation-recovery.test.ts \
  tests/task-session-terminal-failure-recovery.test.ts \
  tests/task-session-dispatch.test.ts tests/opencode-streaming.test.ts \
  tests/opencode-client.test.ts tests/git-client.test.ts
```

Lint auto-fix passed. One earlier dispatch invocation failed at
`writeTrustedCommitState` with `Cannot record trusted commit state: state is
incomplete` while publishing a CI correction. It passed in isolated rerun (7/7)
and in the focused integrated selection below; no repeatable divergent state
was found. The focused integrated selection passed **206/206 tests across 19
files**. Final `TMPDIR="$PWD/node_modules/.p5-tmp" yarn validate` passed for
this candidate: lint, format, typecheck, and **1,936 tests across 159 files**.
Full code health does not itself close external-service or lifecycle scenario
coverage.

### Scenario mapping / evidence gaps

| Requirement / scenario                                | Candidate evidence                                                                                                                                                                                                                               | Qualification                                                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REQ-PR-003; VER-PR-003-01/02/03                       | Three failed primary executions persist exhaustion; stateful workflow recovery verifies `Failed`, one explanatory Trello comment, preserved partial work, deduplicated failed outbox event, and pending comment ownership through response loss. | Live Trello/GitHub are deliberately not contacted; the configured service boundaries are replaced by stateful adapters.                                                            |
| REQ-REC-001; VER-REC-001-01                           | Real child finalizes OpenCode success; parent is killed before ledger CAS; fresh child adopts cached result with one execution and zero prepared dispatches.                                                                                     | P3 shutdown/descendant tests cover host process-tree termination; this T2 fixture targets the additional OpenCode-result/ledger-CAS gap.                                           |
| REQ-REC-002; VER-REC-002-01                           | Reconnect-first typed reachable/absent/conflict/unknown tests; second loss after verified recovery/edit; real fresh-parent replacement resume.                                                                                                   | Provider access is controlled by offline CLI fixtures; no provider/network state is inferred from an unavailable result.                                                           |
| REQ-REC-003/004; VER-REC-003-01/004-01                | Durable primary wait/exhaustion tests; P4 stateful route-crash matrices; task-session reconciliation, mutation-queue and canonical project-ownership suites.                                                                                     | These deterministic suites cover the respective failure and ownership transitions; no live Trello/GitHub service is contacted, per task constraint.                                |
| REQ-REC-005/006; VER-REC-005-01/02, VER-REC-006-01/02 | P2 upgrade-artifact/legacy-import and P3 shutdown/process-descendant/adapter-matrix tests pass in full validation; real T2 restart fixtures also preserve source/worktree/index/all refs.                                                        | Prior-phase generic shutdown/upgrade/process tests are inherited evidence; this task adds T2-specific session and process-result recovery rather than repeating container rollout. |
| REQ-IMP-002/004; VER-IMP-002-01, VER-IMP-004-01/02    | Context builder plus real read-only reconstruction/resume fixture; source checkout, staged index, untracked/ignored files and all refs fingerprint unchanged; a second deterministic loss retains lineage.                                       | Repeated loss after a live code edit is covered by deterministic baseline/lineage regression; only the first replacement cycle is billable real-model evidence.                    |
| REQ-CTX-001/002; VER-CTX-001-01/002-01                | Real fresh-parent model recalled distinct plan (`cobalt91`) and actual attachment content (`lantern47`) embedded by the production context builder.                                                                                              | Live Trello attachment download is not exercised; fixture creates an owned external attachment file and proves its content reaches the read-only model context.                    |

### Production OpenCode role inventory

Production task-session routes explicitly classify every OpenCode activity;
advisory stages do not consume the primary execution ledger. Validation's
new-dispatch and reserved-resume branches share one durable activity/operation
identity and are not separate budget categories.

| Role                        | Activities / routes                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary (7 activities)      | Initial implementation; local validation repair; implementation-review repair; CI-review repair; CI correction; human-feedback remediation; human-feedback review repair. |
| Advisory (4 activities)     | Plan generation; initial commit message; CI-repair commit message; feedback-repair commit message.                                                                        |
| Reconstruction (1 activity) | Dedicated read-only replacement-session acknowledgement.                                                                                                                  |

Primary callbacks use persisted operation IDs and durable cycle/pass identities;
CI identity is not reset by a changed PR SHA. Current card and attachment context
is refreshed on primary task-work resumption routes.

The corrected scripts now exercise the previously missing crash boundaries and
fresh-parent replacement resume. The primary replay harness sends a real
OpenCode primary request in a disposable child; after the process writes its
success metadata/result artifact, the orchestrator parent is SIGKILLed before
its ledger CAS. A second fresh Node process inspects and adopts that result with
zero new dispatches. The reconstruction harness replaces only its own
confirmed-absent fixture session, then starts a fresh Node parent that verifies
the replacement-bound session and resumes normal primary work. Its snapshot
includes source checkout HEAD/index/refs/content; worktree HEAD/branch/all refs,
staged index, untracked/ignored files, and external attachment context. Plan and
attachment facts are distinct; the latter's file content is persisted in the
context bundle and recalled by the read-only model request. These are isolated
model/process fixtures, not a live Trello/GitHub lifecycle. Do not infer live
provider semantics or full P5 completion from the harness results.

Real isolated executions (2026-11-08), using CLI 1.18.35,
`openai/gpt-6.1-sol` / `high`, and fresh empty XDG configuration:

```sh
TMPDIR="$PWD/node_modules/.p5-tmp" P5_T2_MODEL=openai/gpt-6.1-sol \
  P5_T2_VARIANT=high yarn tsx scripts/p5-t2-primary-replay.ts
TMPDIR="$PWD/node_modules/.p5-tmp" P5_T2_MODEL=openai/gpt-6.1-sol \
  P5_T2_VARIANT=high yarn tsx scripts/p5-t2-session-reconstruction.ts
```

Primary process-finish/ledger-gap result: root
`node_modules/.p5-tmp/p5-t2-primary-replay-d9nAcl`, primary session
`ses_e443572f6ffe2bVCIgiFvujUmX`, process execution
`ac6d4171-955e-4d02-a919-c74c1651903e`. The pre-replay record remained
`executions: 1, status: dispatched`; fresh-process replay produced
`executions: 1, status: completed, prepared: 0`. The finalized
`execution.json` contains top-level effective `sessionId` and an independently
hashed `result.json`; both remain at the evidence root above.
The retained earlier crash-barrier harness attempt at
`node_modules/.p5-tmp/p5-t2-primary-replay-HXbrkD` reported `status: 137`
rather than Node's `signal: SIGKILL` field, so the first oracle rejected it even
though its persisted process metadata shows `success` and the ledger remained
`dispatched`. The oracle now accepts both host representations and reran through
fresh-process replay; the earlier attempt remains preserved.

Fresh-parent replacement result: root
`node_modules/.p5-tmp/p5-t2-session-reconstruction-GE3mCr`, original session
`ses_e44350f59ffeHzEOV1hSUHYiFY`, replacement session
`ses_e4434bec6ffe330da2ECMLXXdv`, initial primary process
`9bca15da-3df0-413c-907a-53f336a58875`. This historical fixture reported one
normal resumption dispatch and zero reconstruction primary executions. It
recalled the distinct facts `cobalt91` (plan) and `lantern47` (attachment), and
reported source checkout/worktree fingerprints unchanged. Independent review
subsequently found the fixture's prompt/oracle and ignored-versus-untracked
classification inadequate, and replacement verification was manual rather than
the production reconstruction verification. Treat these observations as
unverified candidate evidence pending R5; do not use them as acceptance. Earlier
primary roots
`SssaeU` and `HXbrkD`, and reconstruction roots `ckB365` and failed-oracle
`LVkRrA`, remain preserved alongside the successful evidence; do not remove
any fixture tree or unrelated user sessions.

The candidate terminal-failure regression uses stateful Trello and notification
outbox substitutes. It verifies a Trello comment whose first response is lost
remains pending with ownership, replay produces one effective explanatory
comment, and the configured task-failed outbox entry is deduplicated. Review
found its Set-based comment oracle collapses duplicate effects and is not valid
evidence for append-only Trello mutation behavior; R4 must replace it. Real
provider behavior remains deliberately unclaimed.

The earlier real probe used OpenCode CLI 1.18.35, explicit
`openai/gpt-6.1-sol` / `high`, an empty `XDG_CONFIG_HOME`, and controlled
environment. Session `ses_e44abbedaffeuFfRXv1XjW1Rrb`, execution IDs
`4d22d9a2-e86a-4e10-8159-b3c3adce0b93` and
`9c25ab50-0e65-4821-93aa-cf08999e4418`, evidence at
`node_modules/.p5-tmp/p5-t2-AV31qV/runtime/resume-result.json`. These IDs
evidence the earlier continuity probe, not a primary ledger crash-gap test.
