# P5 WIP checkpoint — NOT READY FOR DEPLOYMENT; T2/P5 NOT COMPLETE

This is a preservation checkpoint, not product acceptance, review approval, or
deployment authorization. Existing source, tests, scripts, and runtime artifacts
are retained as work in progress. The current candidate has unresolved
independent-review findings; do not represent it as having passed independent
review. The supervisor will perform one checkpoint-preservation review and may
commit the WIP checkpoint after that review; this is not product approval.

The ordered remaining work, acceptance boundaries, and reusable implementer
instruction are in [`p5-remaining-activities.md`](p5-remaining-activities.md).
The next implementation activity is **R1** in that backlog. Do not start T3,
T4, T5, or later P5 work until the earlier ordered activities are resolved.
R1–R5 are all pending; partial source edits left by aborted remediation do not
count as completed or verified activities.

Latest checkpoint validation after the permitted formatting-only change passed
`TMPDIR="$PWD/node_modules/.p5-tmp" yarn validate`: lint, format, typecheck, and
**1,936 tests across 159 files**. This verifies the current integrated
candidate's code-health checks only; it does not resolve the findings, establish
independent-review approval, or constitute product acceptance.

This document is a progress handoff only. It does not modify or supersede the
authoritative requirements, architecture, verification scenarios, or rewrite
plan, and it does not claim P5 completion or approval.

## Recorded work (historical candidate evidence, not acceptance)

- **T1 recovery-checkpoint/resumption foundation:** committed as `8c93889`
  (reported validation: 1,880 tests). Consult the commit and its verification
  evidence for the exact recovery-checkpoint/resumption scope.
- **T2 primary-session recovery:** an uncommitted implementation candidate is
  preserved in the worktree. Claimed coverage and harness results below are
  candidate evidence only; the independent review identified unresolved safety
  and oracle defects documented in the backlog. Published session
  reconstruction, active-primary recovery ordering, and reconstruction artifact
  secrecy are not accepted. This is not a claim that T2 is ready or complete.
- Focused validation on 2026-11-08: `TMPDIR="$PWD/node_modules/.p5-tmp"
yarn lint:fix` passed; focused primary-session/recovery/artifact/failure suites
  passed 206/206 across 19 files. An earlier dispatch invocation failed at
  `writeTrustedCommitState` (`Cannot record trusted commit state: state is
incomplete`) during CI publication. It did not reproduce in an isolated
  rerun (`tests/task-session-dispatch.test.ts`: 7/7), the focused integrated
  suite, or full validation. The failure boundary and stack were retained in
  tool output; no repeatable implementation divergence has been found.
  `TMPDIR="$PWD/node_modules/.p5-tmp" yarn validate` passed for the then-current
  integrated candidate: lint, format, typecheck, and **1,936 tests across 159
  files**. This predates resolution of independent-review findings and does not
  establish source correctness or product acceptance. No commit was created for
  that candidate at that point.

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
reconstruction role inventory and route wiring are in the candidate; offline
fault tests and the isolated provider fixtures do not replace independent
review or every mapped outage/container/upgrade scenario.

The role inventory and route wiring are present in the candidate but have
unresolved review findings. Offline tests and isolated provider fixtures do not
replace independent review or every mapped outage/container/upgrade scenario.
The decision does not establish implementation completion. Persist-before-
dispatch accounting, operation replay across a real process-finish/ledger-CAS
gap, active repair resumption, and finalization comment/outbox reconciliation
now have focused regression coverage and isolated executable evidence. Phase
completion still requires the full mapped scenario matrix and independent review.
Ambiguous operations may not be retried until authoritative inspection
establishes safety. Inspection, context reconstruction and waiting are not
operation executions.

## Superseded candidate status (2026-11-08; not current acceptance)

No T2 completion claim is made. The isolated OpenCode probes and stateful test
results in [`p5-t2-verification.md`](p5-t2-verification.md) are historical
candidate evidence, not verified acceptance. Independent review found
unresolved reconstruction routing/gating, recovery-ordering, and artifact
secrecy issues, plus invalid test/harness oracles. No production Trello/GitHub
service was contacted. The recorded full validation predates these findings and
must be rerun after the ordered fixes.

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

## Later tasks

- **T3:** not started.
- **T4:** not started.
- **T5:** not started.

No full-phase approval, deployment, or live Trello/GitHub evidence is claimed
here. Real isolated OpenCode probes are only the limited historical evidence
described above. No authoritative requirements were changed by this handoff.
