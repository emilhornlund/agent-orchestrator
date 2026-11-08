# P5 remaining activities — WIP, not deployment-ready

**Status: NOT READY FOR DEPLOYMENT. T2 and P5 are NOT COMPLETE.** The current
branch contains committed R1 and R2 work and an uncommitted R3 implementation
candidate. The recorded
1,936-test validation predates the independent-review findings below; it is not
current acceptance, and no product acceptance or phase approval is implied.
Keep all existing source, tests, scripts, and evidence artifacts. Do not discard
work or remove artifacts as part of this backlog. The supervisor will perform
one checkpoint-preservation review before committing the WIP checkpoint; that
review is not product approval.

This is the ordered work list. Resolve each activity in order, one at a time.
Items are pending, including items with candidate tests or historical live
evidence. Requirements and scenario IDs below refer to
[`requirements.md`](requirements.md), [`specification.md`](specification.md),
and [`verification.md`](verification.md); the architectural phase scope is
[`rewrite-plan.md`](rewrite-plan.md), especially P5. None of these entries
changes authoritative acceptance criteria.

## Reusable implementer instruction

Copy this instruction for exactly one activity below, substituting its ID and
scope. Do not combine activities.

> Implement only P5 activity **[ID]** from `docs/p5-remaining-activities.md`.
> Read its linked requirements/scenarios and inspect the named code by stable
> symbols, not stale line numbers (use `rg`/`git grep` to locate symbols and
> callers). Preserve all other WIP and artifacts. Add regression tests for the
> stated acceptance, including failure/race boundaries. Run the activity's
> focused tests once after integration, then request one independent review of
> this activity's changed scope—not a full-project re-audit. Consolidate
> blocking findings into one actionable batch and fix them within this activity;
> record non-blocking follow-up without entering an indefinite polish loop.
> Never waive known safety failures or claim acceptance without required checks.
> Do not implement later activities, change the phase plan, commit, push, deploy,
> or discard user work. Use `TMPDIR="$PWD/node_modules/.p5-tmp"` for every
> command that may create temporary files. Report changed files, exact checks,
> evidence/limits, and unresolved issues. Full `yarn validate` is required once
> after the ordered T2 fixes/review, not repeatedly after every focused activity.

## Ordered T2 recovery activities (R1–R2 committed; R3–R6 unresolved)

### R1 — Recover published sessions from durable PR identity and owning checkpoint

**Status:** committed on the current branch; R1 implementation activity is
complete. This does not claim T2 or P5 completion. The prior gate at workflow symbol
`runTaskSessionWorkflow` (locate with `rg`) prevents recovery from reaching
published-session reconstruction; `executionRecoveryCard` also ignores its
result. Published correction-phase implementation is restricted to PR
observation rather than resuming the interrupted owning operation.

**Requirements/scenarios:** P5 scope; REQ-REC-002, REQ-REC-003, REQ-REC-004,
REQ-HR-001, REQ-HR-002, REQ-PR-003; VER-REC-002-01, VER-REC-003-01,
VER-REC-004-01, VER-HR-001-01, VER-HR-002-01, VER-PR-003-02.

**Inspect likely files/symbols:** `src/orchestrator/run-task-session-workflow.ts`
(`runTaskSessionWorkflow`, workflow gates, and `executionRecoveryCard`);
published task-session route dispatch and the
primary-operation recovery/reconstruction symbols under `src/task-session/`.
Locate callers and all phase gates with `rg`, rather than relying on these file
names as an exhaustive inventory.

**Acceptance:** Use persisted PR identity and the owning durable checkpoint to
reconstruct a confirmed-lost primary session, including while the published
attempt is in any correction phase. Handle and propagate the recovery-card
result; do not silently proceed as though recovery succeeded. Resume the
original operation/checkpoint, never start a competing primary operation or
replace the PR. Add restart tests for canonical CI and human-feedback loss
while preserving operation identity. Add merge/close-while-blocked races proving
terminal authority wins and no early ownership release or post-terminal dispatch
occurs. Preserve existing pre-PR behavior.

**Focused checks:** `TMPDIR="$PWD/node_modules/.p5-tmp" yarn vitest run
tests/run-task-session-ci-repairs.test.ts
tests/run-task-session-feedback-remediation.test.ts
tests/reconcile-task-session.test.ts tests/task-session-dispatch.test.ts` plus
the new focused published-restart/terminal-race tests. Adjust to actual test
files discovered by symbol search; do not omit the required scenarios.

**Stop boundary:** Do not change secret sanitization, legacy review ordering,
mutation delivery, later P5 T3/T4/T5, or unrelated workflow routes except the
minimum integration needed for this recovery path.

### R2 — Give active primary operation precedence over legacy review remediation

**Status:** committed on the current branch; R2 implementation activity is
complete. This does not claim T2 or P5 completion. Legacy `reviewRemediationFailure` is
processed before active-primary reservation. After partial edits, restart can
refuse the active operation; an unchanged fallback can publish without review
of the active operation. Primary errors may also be incorrectly represented by
the legacy flag.

**Requirements/scenarios:** P5 scope; REQ-PR-003, REQ-REC-001, REQ-REC-002,
REQ-IMP-004; VER-PR-003-01, VER-REC-001-01, VER-REC-002-01,
VER-IMP-004-01, VER-IMP-004-02. Include existing retry/accounting policy A5:
three total actual primary executions including initial; no new setting, and no
retry of ambiguous operations before authoritative inspection.

**Inspect likely files/symbols:** `runTaskSessionWorkflow`,
`runTaskSessionImplementation`, active primary operation reservation/recovery,
`reviewRemediationFailure`, and review pass/prompt/operation identity handling;
locate definitions and all reads/writes with `rg` under `src/` and related
tests.

**Acceptance:** Reconcile/reserve active primary intent before consulting
legacy-only remediation failure state. Do not write primary errors into that
legacy flag. If restart follows edits or the last pass, resume the exact
persisted prompt, pass, operation ID, and session before any quality gate or
fallback publication. Make `review-failed` transition idempotent when the
attempt is already in implementation. Test interruptions immediately before
and after edits and at the last pass; prove no unreviewed publication and no
duplicate billable execution.

**Focused checks:** existing primary, implementation, review-repair, session
dispatch, and terminal recovery tests located by the symbols above, plus the
new before/after-edit and last-pass restart cases; run them once with
`TMPDIR="$PWD/node_modules/.p5-tmp" yarn vitest run <focused test paths>`.

**Stop boundary:** Do not broaden this into a redesign of review policy, quality
budgets, PR correction policy, or unrelated operation replay.

### R3 — Sanitize reconstruction secrets before persistence and encoding

**Status:** implementation candidate in the worktree; HIGH, blocking. Reconstruction can persist raw card/plan/
diff/history/untracked content and can encode a whole source file as base64,
thereby bypassing the intended redaction channel.

**Requirements/scenarios:** P3/P5 shared boundary; REQ-SEC-001, REQ-SEC-002,
REQ-SEC-003, REQ-LOG-001, REQ-LOG-002, REQ-CTX-001, REQ-CTX-002,
REQ-CTX-004, REQ-IMP-004; VER-SEC-001-01, VER-SEC-002-01,
VER-SEC-003-01, VER-LOG-001-01, VER-LOG-002-01, VER-CTX-001-01,
VER-CTX-002-01, VER-CTX-004-01, VER-IMP-004-01, VER-IMP-004-02.

**Inspect likely files/symbols:** `buildPrimarySessionContext`, reconstruction
bundle/artifact serialization, `primary-result-artifact`, and the redaction /
known-secret helpers in `src/`; use `rg` to enumerate every write and encoding
path for bundle fields.

**Acceptance:** Sanitize each untrusted field before any artifact write and
before any encoding (including base64 or equivalent); never persist raw
unsanitized source content and rely on redacting only the final prompt. Compute
the bundle hash from the actual sanitized persisted bundle. Preserve original
worktree/source/index/refs unchanged. Add canaries to every bundle field and
verify absence in canonical persisted artifacts and decoded outbound
reconstruction content across all channels/encodings. Keep safe content useful
for reconstruction and make sanitation independently testable.

**Focused checks:** context builder, result artifact, source snapshot, and
reconstruction tests located by symbol search, plus canary encode/decode tests;
run once using `TMPDIR="$PWD/node_modules/.p5-tmp" yarn vitest run <focused test paths>`.

**Stop boundary:** Do not claim universal secret detection or change general
logging/process redaction outside this artifact path.

### R4 — Replace false duplicate-comment oracle with canonical mutation journal

**Status:** pending; MEDIUM, blocking to trustworthy failure evidence. Existing
failure-finalization test substitutes a comment body through a `Set`, collapsing
duplicate effects, then expects two submits after a lost response. It cannot
prove the real append-only Trello mutation behavior.

**Requirements/scenarios:** REQ-PR-003, REQ-NOT-001, REQ-NOT-002,
REQ-WF-001, REQ-TR-001, REQ-TR-003; VER-PR-003-01, VER-PR-003-02,
VER-PR-003-03, VER-NOT-001-01, VER-NOT-002-01, VER-WF-001-02,
VER-WF-001-03, VER-TR-001-01, VER-TR-003-01.

**Inspect likely files/symbols:** canonical `ProjectRunAuthority`,
`TrelloClient` comment mutation journal, terminal-failure finalization, and
outbox delivery/deduplication. Find the Set-based fake and expected submit
counts with `rg` in `tests/`.

**Acceptance:** Model stateful transport acceptance and append-only comments
with unique effect IDs and a ledger. Cover initially negative lookup followed
by late acceptance: do not submit a second comment, retain project ownership
until reconciliation establishes outcome, and deduplicate notification outbox
delivery without allowing nonblocking email uncertainty to block workflow
completion. The test must fail if a duplicate real append effect is attempted;
do not assert behavior by collapsing identical strings in a Set.

**Focused checks:** canonical project authority, Trello mutation journal,
terminal failure recovery and notification outbox suites, plus late-acceptance
tests; run once with `TMPDIR="$PWD/node_modules/.p5-tmp" yarn vitest run <focused test paths>`.

**Stop boundary:** Do not add retries or claim provider exactly-once semantics;
do not expand into all mutation classes.

### R5 — Make the reconstruction harness neutral and independently observable

**Status:** pending; MEDIUM. Current prompt supplies all requested answers. The
fixture `.gitignore` was written in the source checkout but was uncommitted, so
the intended ignored file is actually untracked in the worktree. The
replacement-bound check relies on manual verification rather than production
reconstruction verification.

**Requirements/scenarios:** REQ-REC-002, REQ-REC-006, REQ-IMP-004,
REQ-CTX-001, REQ-CTX-002, REQ-TST-001, REQ-TST-002;
VER-REC-002-01, VER-REC-006-01, VER-REC-006-02, VER-IMP-004-01,
VER-IMP-004-02, VER-CTX-001-01, VER-CTX-002-01, VER-TST-001-01,
VER-TST-001-02, VER-TST-002-01.

**Inspect likely files/symbols:** `scripts/p5-t2-session-reconstruction.ts`,
`scripts/p5-t2-session-reconstruction-resume.ts`, fixture construction,
`buildPrimarySessionContext`, production reconstruction verification, and
worktree fingerprint helpers. Find exact fixture commands and assertions with
`rg`; retain existing artifacts.

**Acceptance:** Ask a neutral question that does not contain expected answers.
Commit `.gitignore` in the disposable fixture before creating a worktree. Then
verify the designated ignored file with `git check-ignore`; separately prove a
designated untracked file remains untracked with Git status. Make plan and
attachment facts distinct and assert their actual text reaches context. With a fresh parent,
exercise production replacement-bound reconstruction verification before the
actual primary dispatch; the verification itself is uncounted, while the real
primary dispatch is counted. Independently verify persisted fingerprints and
source/index/ref/worktree preservation. Correct docs' evidence links/IDs to the
actual retained run; keep claims narrow (isolated fixture, not provider
lifecycle).

**Focused checks:** run the reconstruction harness's deterministic/unit tests
and the opt-in real OpenCode harness only if credentials/service are available
and explicitly authorized. Command candidates: `TMPDIR="$PWD/node_modules/.p5-tmp"
yarn vitest run <reconstruction test paths>` and, when executing its real model
probe, `TMPDIR="$PWD/node_modules/.p5-tmp" P5_T2_MODEL=<explicit-model>
P5_T2_VARIANT=<explicit-variant> yarn tsx
scripts/p5-t2-session-reconstruction.ts`. A blocked/unavailable live probe is
not a pass; do not loop or silently substitute.

**Stop boundary:** Do not rewrite other harnesses, delete or regenerate old
evidence, change product defaults, or assert full lifecycle/production behavior.

### R6 — One consolidated T2 independent review and full validation

**Status:** pending until R1–R5 have individually passed their activity checks.

**Requirements/scenarios:** all P5 T2 mappings listed in `rewrite-plan.md` P5,
including REQ-WF-002, REQ-WF-003, REQ-PR-003, REQ-REC-001 through
REQ-REC-006, REQ-IMP-002, REQ-IMP-004, REQ-ENV-002, REQ-ENV-003,
REQ-CTX-001, REQ-CTX-002, REQ-CTX-004 and their mapped VER scenarios. This is
not a waiver of mapped variants or inherited P3/P4 obligations.

**Acceptance:** Obtain one independent review of the integrated T2 changes and
resolve its consolidated blocking findings. Record nonblocking follow-up
without repeated whole-project polish audits. Then run full validation exactly
as required, retaining the output and reporting any failure. Preserve the
previous focused `writeTrustedCommitState` intermittent failure as historical
evidence; it was not proven fixed by isolated reruns. A passing validation is
not phase completion or product acceptance. No source is claimed to have
passed review before this activity is complete.

**Checks:** `TMPDIR="$PWD/node_modules/.p5-tmp" yarn validate`, plus any mapped
T2 scenarios not exercised by this command, classified honestly as passed,
blocked, partial, or unverified. No production service use unless separately
authorized.

**Stop boundary:** Do not begin T3/T4/T5 or claim T2/P5 complete. Completion
decisions remain with the phase planner/supervisor.

## Later P5 activities (not started; do not begin before R1–R6)

### T3 — Setup and recovery/attribution ordering across both workflows

**Status:** pending; not started. Follow P5 scope in `rewrite-plan.md` by
section heading, and requirements REQ-ENV-002, REQ-IMP-002, REQ-IMP-004,
REQ-REF-002 plus VER-ENV-002-01, VER-IMP-002-01, VER-IMP-004-01,
VER-IMP-004-02 and mapped refinement scenarios where the
shared setup route applies.

**Inspect:** setup dispatch and before/after attribution symbols in both
implementation and refinement workflows; setup persistence/verification,
source snapshot, relevance result parsing, and tests. Locate all callers with
`rg` before editing.

**Acceptance:** Configured setup precedes refinement and implementation;
persist independently attributable before/after effects; skip setup only when
previous success is verified and still safe; preserve unrelated setup changes.
Agent relevance judgments govern inclusion, while unknown/unsafe attribution
blocks unsafe committing and never silently stages or discards changes. Test
ordering and crash/restart boundaries in both workflows, including setup
failure preventing agent dispatch.

**Focused checks:** setup, source snapshot, implementation and refinement
workflow tests located by symbols; `TMPDIR="$PWD/node_modules/.p5-tmp" yarn
vitest run <focused test paths>`.

**Stop boundary:** No broader refinement rewrite, new setup configuration, or
later P9 scope.

### T4 — Optional per-activity model/variant defaults and clarification

**Status:** pending; not started. Follow P5 scope and REQ-ENV-003,
REQ-CTX-002; VER-ENV-003-01, VER-CTX-002-01. Honor the existing A5 constraint: no new primary retry
configuration.

**Inspect:** config schema/default resolution and each OpenCode activity's
model/variant selection, plus unclear-task/essential-information outcomes.
Locate role dispatch and config references with `rg` across `src/`, `tests/`,
and configuration docs.

**Acceptance:** Optional per-activity choices fall back to OpenCode defaults
when absent; an explicitly unavailable choice is reported without substitution.
Separate service/quality settings from primary execution retry accounting.
After examining available task/attachment context, essential missing
information reaches the required clarified failure outcome without fabricating
work. Add absent/default and explicit-unavailable setting tests; clarification
has its separate REQ-CTX-002 boundary. No speculative options or paid-only
functionality.

**Focused checks:** config validation/default tests, role dispatch tests, and
clarification tests found by symbol search; `TMPDIR="$PWD/node_modules/.p5-tmp"
yarn vitest run <focused test paths>`.

**Stop boundary:** No unrelated configuration redesign, automatic retries, or
later P6 quality/publication policy.

### T5 — P5 integration scenarios and evidence map

**Status:** pending; not started. Use all P5 mappings in `rewrite-plan.md` and
scenario definitions in `verification.md`; include REQ-WF-002, REQ-WF-003,
REQ-PR-003, REQ-REC-001 through REQ-REC-006, REQ-IMP-002, REQ-IMP-004,
REQ-ENV-002, REQ-ENV-003, REQ-CTX-001, REQ-CTX-002, REQ-CTX-004 and
VER-WF-002-01, VER-WF-002-02, VER-WF-003-01, VER-PR-003-01,
VER-PR-003-02, VER-PR-003-03, VER-REC-001-01 through VER-REC-006-02,
VER-IMP-002-01, VER-IMP-004-01, VER-IMP-004-02, VER-ENV-002-01,
VER-ENV-003-01,
VER-CTX-001-01, VER-CTX-002-01, VER-CTX-004-01.

**Inspect:** existing fault harnesses, actual Git/process fixtures, scenario
IDs in `verification.md`, and evidence records. Search for each scenario ID in
tests/docs to map actual executable coverage; do not infer coverage from a
similar test name.

**Acceptance:** Map each applicable scenario and criterion to a concrete test
or executable evidence, state the required evidence level, and label outcome
passed/partial/blocked/unverified. Exercise integrated recovery, setup/context,
and terminal precedence at application boundaries; include realistic levels
where specified. Record all gaps without upgrading isolated mock/CLI evidence
to provider or deployment evidence. No production mutations.

**Focused checks:** mapped scenario tests/harnesses only, once per integrated
activity; every live/external check requires explicit authorization and safe
disposable resources.

**Stop boundary:** Evidence mapping does not waive a scenario, change its
acceptance criteria, or claim whole-P5 completion.

### P5-CLOSE — Whole-P5 verification, review, and clean-worktree closure

**Status:** pending; only after R1–R6 and T3–T5. This is P5 closeout, not P6
work and not authority to deploy; it is phase evidence for the planner's
completion decision.

**Requirements/scenarios:** all mapped P5 requirements/scenarios in the plan
and verification catalog, with each evidence level explicit.

**Acceptance:** One whole-P5 review and required full validation after all P5
activities; resolve blocking safety defects and honestly record nonblocking
gaps. Confirm documented and executable evidence corresponds to the reviewed
tree, no unexplained changes/artifacts are discarded, and the phase is not
declared complete if required criteria remain open. A clean worktree is a
required closure check for that later phase, not a reason to erase this current
WIP checkpoint. The planner/supervisor decides completion; this backlog makes
no completion claim.

**Checks:** `TMPDIR="$PWD/node_modules/.p5-tmp" yarn validate`, all mapped P5
verification scenarios at required levels, and supervisor-required clean-tree
inspection. Keep live services out of tests unless authorized.

**Stop boundary:** No P6+ implementation, deployment, merge, or release action.
