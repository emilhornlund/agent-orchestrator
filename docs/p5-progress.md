# P5 progress — source activities committed; T2 offline PASS; T5 evidence partial

The WIP checkpoint is preserved in `c0f3a8c`. R1–R5, R6, T3a–c and T4a–b are
committed; source activities have scoped independent reviews, and the consolidated
T2 offline validation is PASS. T5 records a focused integration suite and a
scenario-by-scenario partial/blocked evidence map in
[`p5-verification.md`](p5-verification.md). It does not claim product acceptance,
deployment authorization, or P5 completion. Existing source, tests, scripts,
upgrade artifacts and historical probes are retained; invalid historical probes
are not current acceptance evidence.

The ordered work and acceptance boundaries remain in
[`p5-remaining-activities.md`](p5-remaining-activities.md). T1 is `8c93889`
(with WIP checkpoint `c0f3a8c`). T2 R1–R5 are `8a877cc`, `82022b7`, `2ca333c`,
`2e14672`, `bda892f`; R6 is `f5ea817`. T3a–c are `aed8c4f`, `978aa41`,
`bea3370`; T4a–b are `d596832`, `bf30ec0`. The source scoped review status and
T5 integrated evidence limitations are detailed in `p5-verification.md`. P5
remains open; do not claim completion.

The earlier **1,936 tests across 159 files** validation predates R1–R5 and is
historical only. The initial R6 full validation failed with **12 failed and
1,952 passed tests**. The suites and failure causes are preserved in the R6
evidence section below. Remediation skips unnecessary session/worktree
reconciliation for idle healthy Human Review cards (without bypassing terminal
PR observation or reconciliation before feedback work), and completes the
maintenance dispatch fixture's authoritative GitHub/worktree state. A subsequent
integrated review found and prompted a fix for published feedback-correction list
ownership, keyed to both durable PR identity and feedback-remediation ownership.
The post-finding `TMPDIR="$PWD/node_modules/.p5-tmp" yarn validate` passed with
**1,966 tests across 161 files**. Validation does not establish product
acceptance or complete the P5 phase.

This document is a progress handoff only. It does not modify or supersede the
authoritative requirements, architecture, verification scenarios, or rewrite
plan, and it does not claim P5 completion or approval.

## Recorded work and evidence status

- **T1 recovery-checkpoint/resumption foundation:** committed as `8c93889`
  (reported validation: 1,880 tests). Consult the commit and its verification
  evidence for the exact recovery-checkpoint/resumption scope.
- **T2 primary-session recovery:** R1–R5 are committed and have each passed
  scoped offline checks and independent scoped review. R1 covers published
  session recovery at owning checkpoints; R2 active-primary precedence; R3
  reconstruction-secret sanitation; R4 append-only mutation evidence; and R5
  neutral offline harness verification. The exact integrated test mapping and
  remaining evidence levels are in [`p5-t2-verification.md`](p5-t2-verification.md).
  R6 consolidated offline review/validation is PASS; this does not close mapped
  provider or full-lifecycle scenarios. T2 implementation is recorded complete
  at its offline activity gate only, not as P5 acceptance.
- Focused validation on 2026-11-08: `TMPDIR="$PWD/node_modules/.p5-tmp"
yarn lint:fix` passed; focused primary-session/recovery/artifact/failure suites
  passed 206/206 across 19 files. An earlier dispatch invocation failed at
  `writeTrustedCommitState` (`Cannot record trusted commit state: state is
incomplete`) during CI publication. It did not reproduce in an isolated
  rerun (`tests/task-session-dispatch.test.ts`: 7/7), the focused integrated
  suite, or full validation. The failure boundary and stack were retained in
  tool output; no repeatable implementation divergence has been found.
  `TMPDIR="$PWD/node_modules/.p5-tmp" yarn validate` passed for the earlier
  integrated candidate: lint, format, typecheck, and **1,936 tests across 159
  files**. This predates R1–R5 and is not the R6 validation. No live Trello or
  GitHub services were contacted for that candidate.

## A5 decision recorded (policy decision only; implementation unverified)

The policy owner approved **three total primary-operation executions including
the initial execution** (at most two recovery executions). Reuse the shared
default extracted from existing service retry limits; do not add a separate
configuration key. Service-request retry accounting remains semantically
separate from primary-operation execution accounting.

The replacement-bound repository fingerprint is persisted before dispatch and
must remain unchanged through reconstruction verification. Context availability
is an orthogonal wait field and must not replace replacement-creating,
replacement-ambiguous, or replacement-bound state. The baseline lifetime ends
only at reconstruction verification or an explicit safety blockage.
Context failures use the existing configured recovery interval when available;
they do not change replacement phase or baseline. The primary/advisory/
reconstruction role inventory and route wiring have passed scoped source review
and the consolidated offline T2 gate. Offline tests and isolated provider
fixtures do not replace every mapped outage/container/upgrade scenario. Persist-before-
dispatch accounting, operation replay across a real process-finish/ledger-CAS
gap, active repair resumption, and finalization comment/outbox reconciliation
have focused regression coverage and isolated executable evidence. Phase
completion still requires the mapped scenario evidence and later whole-P5 review.
Ambiguous operations may not be retried until authoritative inspection
establishes safety. Inspection, context reconstruction and waiting are not
operation executions.

## Historical probe records (2026-11-08; preserve, do not promote)

Historical OpenCode probes, including the invalid-probe observations, remain
preserved in [`p5-t2-verification.md`](p5-t2-verification.md). The later R5
offline harness regression is a scoped PASS, distinct from those historical live
probes. No revised live R5 probe has been executed; required live/provider,
deployment, and mapped scenario evidence remains partial, blocked, or unverified
as identified in the evidence map. No production Trello/GitHub service was
contacted. A full validation does not substitute for those required levels.

The historical live fixtures use OpenCode CLI 1.18.35 with explicit
`openai/gpt-6.1-sol` / `high`; primary replay is retained at
`node_modules/.p5-tmp/p5-t2-primary-replay-d9nAcl` (session
`ses_e443572f6ffe2bVCIgiFvujUmX`, execution
`ac6d4171-955e-4d02-a919-c74c1651903e`) and reconstruction at
`node_modules/.p5-tmp/p5-t2-session-reconstruction-hdWEV6` (original session
`ses_e44350f59ffeHzEOV1hSUHYiFY`, replacement
`ses_e4434bec6ffe330da2ECMLXXdv`). See the verification record for full
pre/post ledger and artifact details. Every Yarn command used
`TMPDIR="$PWD/node_modules/.p5-tmp"`.

## Current T5 evidence status

- `TMPDIR="$PWD/node_modules/.p5-tmp" yarn test:p5` passed **522 tests across
  35 files**.
- `TMPDIR="$PWD/node_modules/.p5-tmp" yarn test:p3:container` passed the
  existing Podman suite (**610 tests across 36 files**), including the P3
  shutdown fixture. The first invocation's missing container `TMPDIR` failure
  and fix/rerun are recorded in the evidence map.
- The first full-validation invocation stopped at Prettier for the new evidence
  docs; those docs were formatted. The final
  `TMPDIR="$PWD/node_modules/.p5-tmp" yarn validate` passed ESLint, Prettier,
  typecheck, and **2,015 tests across 163 files**.
- T5 does **not** finish mapped scenario acceptance: realistic external
  scenarios are blocked/unexecuted, deterministic integration coverage is
  partial for many rows, and A2/A5 decisions remain unresolved. No P5 completion,
  deployment or live-service claim is made.

## REC-005 bounded continuation evidence (candidate based on `3139ebe`)

- Added `tests/p5-shutdown-continuation.integration.test.ts`: a fresh process
  takes over the real local project lease after SIGTERM, verifies that the
  prior primary execution's process has stopped and its operation/session
  lineage matches, then adopts a test-authored completed result without a second
  dispatch. The custom artifact/inspect callback do not exercise production
  `ProcessRuntime`, `inspectPrimaryOperation`, OpenCode process evidence, or
  startup-to-workflow end-to-end recovery. The same operation remains at one
  execution, and actual dirty Git source bytes remain unchanged. Existing P3
  shutdown test remains the evidence for owned-child drain and no claims after
  shutdown; these are separate fixtures, not one composed production flow.
- Added `yarn test:p5:container`, which reuses `Containerfile.p3-test` and runs
  only the focused P3/P5 shutdown, P2 prior-writer artifact and migration tests
  with `TMPDIR=/tmp`, without host mounts or credentials. Local Podman run
  passed **4 files / 20 tests**. Local extended focused run passed **5 files /
  21 tests**, including P4 actual prior-writer archive compatibility; that test
  cannot run in the existing container because its build context/image excludes
  `.git`. No deployment or unknown C2 orphan-liveness resolution is claimed.
  The Podman run preceded the later test-child cleanup guard; the corrected
  fixture passed locally, but the container command was not repeated after that
  test-only safety correction.
- REC-005-02 adds no invented current-state-only assertion: container P2 case
  reads the checked artifact generated by prior writer `05319ea`; local P4 test
  archives and executes the actual prior P3 writer from `fe32760`; existing
  migration test kills a real child at durable stages and retries while
  checking original state bytes. Unsupported/corrupt originals stay preserved.
- The exact AC mapping, missing variants and evidence-level limits are in
  `p5-verification.md`. Full `TMPDIR="$PWD/node_modules/.p5-tmp" yarn validate`
  passed once: lint, format, typecheck and **2,048 tests across 165 files**.
  Evidence recording edits after validation change documentation only. P5
  remains open.

No full-phase approval, deployment, or live Trello/GitHub evidence is claimed
here. Real isolated OpenCode probes are only the limited historical evidence
described above. No authoritative requirements were changed by this handoff.
