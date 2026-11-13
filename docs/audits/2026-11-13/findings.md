# Prioritized findings register

Revision: 2aa7561743add264eb8eb00c29993721630cbedf. Findings do not authorize implementation.

## AUD-004 — Critical — Exclusive ownership is conditional on an operator-established shared mount, not enforced for incompatible namespaces

Kind: Confirmed static safety-contract gap; deployment-conditional, not observed live contention

Criteria/source: REQ-CFG-003/AC-01, REQ-CFG-003/AC-04, requirements:L459, REQ-ENV-001/AC-02,
REQ-TST-001/AC-02

Expected: Instances on the same machine targeting canonical integrations must not compete;
incompatible coordination setup must prevent startup/claims safely.

Observed/evidence: acquireProjectOwnership at project-ownership.ts:661-683 validates only the
configured root and its local marker, then locks root/key.lock. Two separately provisioned protected
directories with matching marker IDs each have independent lock inodes and no previous local owner
metadata; both pass this path for identical canonical Trello/GitHub integrations. There is no shared
host anchor outside the supplied root. docs/configuration.md:95-99 and 173-175 explicitly admit
copied markers/hidden mounts cannot be detected and make common-mount correctness an operator
contract. That qualification is weaker than requirements.md:459-464 and specification.md:892-898.
Same-root locking and ambiguity fences are substantial and tested; this finding does not allege they
fail.

Uncertainty: Requires independently provisioned/mis-mounted roots on the same host; no live
services, competing production owner, or new lock fixture was invoked. Static path and explicit
operational documentation establish the qualification. Actual unsafe competing ownership impact
motivates Critical severity, conditional on this deployment mistake.

Recommended action (separate authorization required): Obtain explicit
requirements/deployment-contract resolution. Separately authorize enforceable host-wide coordination
anchoring/attestation or explicitly approved scope qualification, plus
two-distinct-root/container-mount negative tests. Do not silently weaken the specification or deploy
duplicate roots.

## AUD-006 — High — OpenCode filesystem mount exposes credentials for unrelated providers

Kind: Confirmed static least-privilege boundary gap

Criteria/source: REQ-SEC-001/AC-02, REQ-SEC-002/AC-04, requirements:L706, requirements:L713,
REQ-SEC-002/AC-02, REQ-TST-001/AC-02

Expected: Give child processes only credentials required by their assigned operation, withholding
unrelated configured credentials from agent/process inputs.

Observed/evidence: buildChildEnvironment filters provider environment variables
(child-environment.ts:212-217), but production isolatedOpenCodeDispatch bind-mounts the entire
~/.local/share/opencode directory writable at isolated-dispatch.ts:85-105, then mounts its auth.json
read-only at 106. Neither step filters that file's provider entries. With explicit model openai/...
and an operator auth.json containing both OpenAI and Anthropic credentials, the assigned child can
read both. Whole OPENCODE_CONFIG/config directory is also mounted at 79-80. Read-only mount prevents
edits, not credential access. Actual isolation fixture checks repository/runtime write denial, not
provider-auth read isolation.

Uncertainty: Conditional on multi-provider credentials in shared OpenCode auth/config. This is
established unnecessary input exposure, not demonstrated transmission of those values to a remote AI
or logs. No real credential file was read during audit.

Recommended action (separate authorization required): Separately authorize per-operation
credential/config isolation with only selected provider access while preserving supported default
selection/session continuity; add filesystem canary tests for unrelated provider credentials. Do not
copy or inspect live secret contents to reproduce.

## AUD-001 — Medium — Human requests containing an orchestrator marker are silently excluded

Kind: Confirmed static production-path contradiction

Criteria/source: REQ-HR-001/AC-05, requirements:L219, REQ-HR-001/AC-01, REQ-TST-001/AC-02

Expected: Exclude orchestrator-authored replies and bot status, not actionable requests authored by
a human merely quoting an earlier status.

Observed/evidence: poll-project.ts:113 calls run-task-session-workflow, which refreshes feedback
using run-task-session-feedback-cycle.ts:226-240. Its toFeedbackEntries predicate at lines 150-154
requires a nonbot/nonautomation author AND rejects every body containing `<!-- agent-orchestrator-`.
A human request such as `Please fix X; prior status was <!-- agent-orchestrator-outcome:start -->`
is removed before classifyCurrentFeedback. Both reviews/inline comments (155-172) and standalone
comments (198-200) use the predicate. Decisive static counterexample; no live mutation or new test
was run.

Uncertainty: Marker-free normal feedback is covered. A real human quoting/copying hidden marker
bytes is required for this edge case; no frequency claim. Existing select-actionable-feedback tests
do not exercise the production conversion predicate.

Recommended action (separate authorization required): Authorize a separate change to use trusted
author/provenance identity for exclusions and preserve human requests quoting managed content; add
production-path regression coverage.

## AUD-002 — Medium — Active task queue imposes a finite lifetime operation count on unlimited human rounds

Kind: Confirmed static production-path contradiction

Criteria/source: REQ-HR-005/AC-01, requirements:L242, REQ-HR-006/AC-04, REQ-TST-001/AC-02

Expected: Human-requested-change rounds have no fixed lifetime limit while a PR remains open; only
per-cycle automation budgets are bounded.

Observed/evidence: task-mutation-queue.ts:48 caps all queue events at 10,000. enqueue at 266-289
appends every new event; completion/retirement map existing entries rather than remove/archive them
(350,475,510,665,702). Per-attempt authority queue persists for the lifetime of the open PR. Thus
sufficiently many unique human rounds/observations eventually make the next enqueue fail schema
validation even though the PR remains open. No normal event compaction/removal exists in this queue.
Static decisive limit; not a claim that current deployments reached it.

Uncertainty: Exact round at failure depends on other events per cycle and may be far below/above
practical task lifetimes. Additional record-size limits may be reached earlier. No stress fixture
executed.

Recommended action (separate authorization required): Separately authorize bounded active-queue
storage with archived trace history and preservation of deduplication/prerequisite identities, then
verify more-than-limit distinct rounds without losing ownership.

## AUD-003 — Medium — A permanently pending expected check suppresses repair of known failed checks

Kind: Confirmed static contradiction, supported by existing executed unit assertion

Criteria/source: REQ-CI-002/AC-01, REQ-CI-002/AC-02, requirements:L260, REQ-CI-001/AC-01,
REQ-TST-001/AC-02

Expected: Offer bounded automatic correction of actionable failed GitHub CI checks; bounded
observation of missing/pending checks must not indefinitely hide already available failures.

Observed/evidence: evaluate-ci-checks.ts:218-245 accumulates known failures but returns status
waiting (without failures) whenever any expected check is missing/pending.
tests/evaluate-ci-checks.test.ts:206-215 explicitly demonstrates failed Build plus queued Tests
yields waiting and no failures. Production run-task-session-workflow.ts:2407-2452 only enters CI
correction for status failed; timed-out waiting transitions to human feedback then continues. The
observer likewise queues repair only for failed (active-pr-observation.ts:195-207). If Tests never
completes, known Build failure never reaches repair/diagnostic callback even after the wait bound.

Uncertainty: PR delivery remains possible and draft uncertainty is reported; this is missed bounded
repair, not evidence of infinite Working. Static composition plus reused unit execution, no new/live
test.

Recommended action (separate authorization required): Separately authorize preserving actionable
failure details alongside incomplete-check uncertainty and offering the bounded repair episode after
the observation window; add full polling regression with one failed and one never-finishing check.

## AUD-005 — Medium — Dirty cleanup status is copied from Git stdout into orchestrator logs

Kind: Confirmed static production-path contradiction

Criteria/source: REQ-LOG-002/AC-02, REQ-LOG-002/AC-03, requirements:L330, requirements:L334,
REQ-TST-001/AC-02

Expected: Structured orchestrator diagnostics contain sanitized concise facts and child artifact
references, not raw child-process output.

Observed/evidence: cleanup-worktree.ts:136-145 obtains Git status/getCleanupStatus and embeds the
entire returned status in Error('Refusing to remove dirty worktree ...\n${status}'). Terminal
cleanup catches this and logs message(error) verbatim in
reconcile-terminal-task-session-pr.ts:89-92. logger.ts:79 redacts known secret values but still
writes the raw status text at 118. Thus preserved dirty work on normal terminal cleanup routes Git
stdout into orchestrator log, despite separate raw process artifacts. Existing cleanup-preservation
tests prove this error branch is reachable with real dirty Git worktrees; no assertion there checks
terminal logger output.

Uncertainty: This is a logging-channel violation, not demonstrated disclosure of a registered
secret; logger redaction remains effective for its known values. No arbitrary-secrets claim.

Recommended action (separate authorization required): Separately authorize a bounded structured
cleanup diagnostic with artifact reference, leaving raw status solely in child evidence; add
terminal-production-path log assertion using dirty paths.

## AUD-007 — Medium — Repository grounding, scope and feedback-semantic obligations lack real judgment evidence

Kind: Verification gap, not a confirmed universal behavior defect

Criteria/source: REQ-REF-001/AC-01, REQ-REF-001/AC-02, REQ-REF-001/AC-03, REQ-REF-002/AC-02,
REQ-REF-002/AC-03, REQ-REF-003/AC-01, REQ-REF-003/AC-02, REQ-REF-003/AC-03, REQ-REF-003/AC-04,
REQ-REF-005/AC-03, REQ-IMP-001/AC-03, REQ-IMP-002/AC-01, REQ-IMP-002/AC-02, REQ-IMP-003/AC-01,
REQ-IMP-003/AC-02, REQ-IMP-004/AC-02, REQ-IMP-004/AC-03, REQ-HR-001/AC-01, REQ-HR-001/AC-03,
REQ-HR-003/AC-02, REQ-HR-003/AC-04, REQ-HR-004/AC-02, REQ-HR-006/AC-04

Expected: Refinement/implementation use actual repository evidence and preserve objective; feedback
actionability and adequate fix claims reflect substantive human intent.

Observed/evidence: Refinement parser validates nonblank fields and enum;
build-refinement-prompt.ts:125-141 supplies instructions but canned output does not prove actual
grounding/scope. classify-current-feedback.ts:64-114 validates exact response coverage/revisions but
semantic change/actionability is supplied by OpenCode. Retained tests simulate judgment. See REF,
IMP, HR and CTX traces/criterion gaps.

Uncertainty: No real model judgment or live output quality exercised. Prompt/schema presence is not
proof; this does not claim a model always fails.

Recommended action (separate authorization required): Separately authorize representative real-agent
evidence-based refinement/planning/actionability/fulfillment scenarios, retaining expected
observable boundaries without moving engineering judgment into deterministic orchestration.

## AUD-008 — Medium — Container and live-service realistic-baseline qualification remains incomplete

Kind: Verification gap, not a reproduced deployment defect

Criteria/source: REQ-ENV-001/AC-01, REQ-TST-001/AC-04, REQ-TST-003/AC-03, REQ-TST-001/AC-02

Expected: Equivalent local/container lifecycle and a trustworthy realistic integrated baseline
beyond isolated units.

Observed/evidence: CONTRIBUTING.md:93-99 explicitly distinguishes meaningful stateful local
integration from a live-service baseline. Containerfile and runtime policy inspected; reused yarn
build is TypeScript compilation, not image/lifecycle test. Real local Git/process/SMTP fixtures are
substantial modeled evidence but not live Trello/GitHub/OpenCode or mounted container execution.

Uncertainty: No live/container commands run under read-only audit. Existing local integration is not
discounted as mere unit mocks. A dedicated live environment is not prerequisite to correcting static
defects.

Recommended action (separate authorization required): Separately authorize deployment qualification
covering shared namespace mounts, persistent session/state, nested sandbox, SIGTERM/restart and
provider mutations in disposable service resources; retain exact environment/results.

## AUD-010 — Medium — Residual full-path recovery and boundary evidence is insufficient for broad compliance claims

Kind: Verification gaps, distinct from confirmed defects

Criteria/source: REQ-WF-002/AC-01, REQ-WF-002/AC-02, REQ-WF-002/AC-03, REQ-PR-007/AC-02,
REQ-TR-003/AC-02, REQ-TR-004/AC-01, REQ-TR-004/AC-03, REQ-VAL-004/AC-02, REQ-VAL-004/AC-03,
REQ-CI-001/AC-01, REQ-CI-001/AC-03, REQ-CI-002/AC-02, REQ-CI-002/AC-05, REQ-MNT-001/AC-03,
REQ-MNT-003/AC-03, REQ-REC-001/AC-04, REQ-REC-003/AC-04, REQ-REC-004/AC-01, REQ-REC-004/AC-02,
REQ-REC-004/AC-03, REQ-REC-005/AC-02, REQ-REC-006/AC-03, REQ-GIT-002/AC-01, REQ-GIT-006/AC-03,
REQ-CFG-002/AC-02, REQ-CFG-002/AC-03, REQ-CFG-003/AC-01, REQ-CFG-004/AC-01, REQ-CFG-004/AC-02,
REQ-CFG-005/AC-04, REQ-CFG-006/AC-02, REQ-LOG-001/AC-01, REQ-LOG-002/AC-03, REQ-SEC-001/AC-01,
REQ-SEC-002/AC-01, REQ-SEC-002/AC-02, REQ-SEC-002/AC-04, REQ-ENV-002/AC-04, REQ-ENV-002/AC-07,
REQ-CTX-001/AC-01, REQ-CTX-002/AC-01, REQ-CTX-003/AC-01, REQ-CTX-003/AC-02, REQ-CTX-004/AC-03

Expected: Bounded recovery/progress, ordering, optional-startup boundaries and card/setup invariants
have observable full production-path evidence.

Observed/evidence: Known mutation, process, shutdown and migration fixtures demonstrate substantial
recovery. Matrix nevertheless identifies generalized unexpected-idle/corruption progress, exhaustive
internal outcome handling, repeated Failed polling, mixed eligibility ordering, optional
dependency-only startup, post-PR setup, and running configuration/card-content invariants where
cited assertions do not establish the complete obligation. See WF/REC/TR/CFG/ENV/CTX criterion rows;
no absence-of-evidence-as-compliance inference.

Uncertainty: Tests may exist beyond cited evidence; audit does not assert every unqualified behavior
is defective. Some waits are legitimate safety uncertainty and must not be forced terminal.

Recommended action (separate authorization required): Separately authorize focused
production-entry-point regression/qualification scenarios for exact pending evidence obligations,
preserving safe uncertainty and bounded retry policies.

## AUD-009 — Low — Outside-Git runtime storage is normative but absent from individual CFG-005 acceptance bullets

Kind: Specification criterion coverage omission

Criteria/source: REQ-CFG-005/AC-02, requirements:L667

Expected: Every authoritative behavior has an individual verifiable criterion, including durable
runtime state outside repositories/worktrees.

Observed/evidence: requirements.md:667-668 explicitly requires outside-Git storage.
specification.md:916-917 repeats it in normative prose, but ACs at 921-927 cover
persistence/configurability/pinning/manual editing without an explicit outside-Git separation
acceptance bullet. requirements-map.json flags AC-02 as indirect, not complete equivalence. Actual
code config.ts:344-425 and queue path checks enforce separation on traced paths.

Uncertainty: Documentation omission in criterion granularity, not claim that implementation stores
runtime state inside Git. Normative specification prose remains authoritative for audit.

Recommended action (separate authorization required): Seek separate document authorization to
add/clarify an explicit observable separation criterion and corresponding path-boundary
verification; never change documents merely to fit implementation.
