# Specification audit remediation

Historical reports in this directory describe the original audited revision and remain unchanged.
This page tracks the separately authorized remediation campaign from `e0c0eec`.

## AUD-004 — Unresolved: host trust boundary required

Verified against `src/coordination/project-ownership.ts`: acquisition validates the supplied root,
marker, and lock inode, but two independently provisioned roots admit independent locks. This
violates REQ-CFG-003/AC-01 and AC-04 (specification lines 892–898); same-root serialization and
independent-project concurrency do not establish incompatible-mount safety.

A second configurable filesystem anchor merely relocates this problem: a container can privately
mount that anchor too. Abstract Unix sockets likewise depend on a shared network namespace. Binding
a marker to its inode detects copies, not independently provisioned roots. None establishes
host-wide identity across arbitrary mount/PID/network namespaces. Adding one as a complete fix would
silently retain the audited safety gap. Safe enforcement needs a host-controlled coordination
service or an administrator-attested host boundary and a defined supported container deployment
contract. That architectural/deployment decision cannot safely be invented in this patch. No
requirements were weakened and no production coordination behavior was changed. Do not run duplicate
roots.

Recommended next action: agree on a host-owned coordination endpoint, its authentication and
availability/recovery contract, then qualify negative distinct-root and mis-mounted-container cases
as well as crash fencing and independent-project concurrency. AUD-004 remains Critical and
unresolved.

## AUD-006 — Unresolved: filesystem credential projection

Confirmed in `isolated-dispatch.ts`: the whole OpenCode data directory and operator configuration
are visible to the child; the read-only auth overlay does not filter provider entries. Environment
filtering in `child-environment.ts` does not close this filesystem boundary. REQ-SEC-001/AC-02 and
REQ-SEC-002/AC-04 remain violated for multi-provider auth/configuration.

No real credential files were inspected. A safe correction must project both auth and configuration,
including provider options, credential-file references, plugins, default selection and resumed
session authentication, while keeping session data durable. Filtering only auth.json or explicit
model dispatches would leave other production paths exposed. This campaign has not established
OpenCode's complete merged-configuration/authentication contract sufficiently to implement that
projection without breaking supported authentication. This is an unresolved implementation task, not
an invalid finding or evidence of compliance. Use a dedicated OpenCode home/configuration containing
only operation-required credentials until a tested projection is available. Qualification must use
synthetic multi-provider canaries, never operator secrets.

## AUD-001 — Corrected: human marker quotations

REQ-HR-001/AC-01 and AC-05: production feedback conversion now filters by author identity/bot
provenance, not body marker bytes. Regression coverage calls `refreshCurrentTaskFeedback` with human
review, inline and conversation requests quoting a marker, and retains the existing self/bot
exclusion test. Semantic discussion classification remains responsible for non-requests.

## AUD-002 — Corrected: queue lifetime history

REQ-HR-005/AC-01 and REQ-HR-006/AC-04: terminal descriptors are archived before snapshot compaction,
with durable per-event identities for deduplication and later prerequisites. Pending/active/failed
work and prerequisite closure are never discarded. Snapshots retain recent outcomes, not the entire
task lifetime; the existing 10,000 bound now constrains simultaneous retained work rather than
ordinary sequential human rounds. History grows on disk for traceability, not in every queue read.
The CI observer uses historical lookup to avoid re-enqueuing compacted observations. Regression
coverage processes 10,005 distinct rounds with periodic reopening, then verifies archived duplicate
suppression, identity-conflict rejection, prerequisites and interrupted-writer recovery.

## AUD-003 — Corrected: mixed failing and pending CI

REQ-CI-001/AC-01–03 and REQ-CI-002/AC-01–02: with verified current-head expectations, known failures
now take repair precedence over missing/pending results. Missing/pending names remain in the failed
evaluation; they never count as passes. Unknown expectation completeness, stale heads and malformed
observations still fail closed. Unit coverage and the production active-PR observer verify mixed
results enqueue one repair across repeated polling/reopening. Existing episode budgets remain
unchanged. This is simulated provider evidence, not a live CI qualification.

## AUD-005 — Corrected: bounded cleanup diagnostics

REQ-LOG-002/AC-02–03: dirty status, unmerged paths and observed branch text are no longer copied
from Git stdout into cleanup exceptions. Typed diagnostics contain a fixed reason, numeric size or
count and a process-artifact directory reference. Raw command output remains in child evidence. The
terminal production path is tested with real Git and a synthetic dirty-path canary: the warning
omits raw status/path text, remains bounded, identifies preserved work and leaves its contents
intact.

## AUD-009 — Corrected: explicit outside-Git storage criterion

Appended REQ-CFG-005/AC-05 without renumbering existing criteria. It directly expresses the
authoritative outside-Git storage obligation at requirements lines 667–672; product intent and
implementation are unchanged. Existing `config.test.ts` overlap/normalization cases and queue
storage boundary tests provide focused deterministic evidence, not container deployment evidence.

## Remaining verification gaps — reviewed, not blanket compliance

Reviewed all 61 partial and 10 unverified rows in the original 305-criterion matrix, including
AUD-007, AUD-008 and AUD-010. The following disposition covers every such row. `AC` numbers are
local to each named requirement. A test gap alone is not a confirmed implementation defect.

| Requirement / ACs                                               | Disposition and remaining evidence needed                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WF-002 / 01–03                                                  | Additional production-entry recovery scenarios; clarify the supported corrupt-state recovery boundary. Arbitrary inconsistency must not authorize release or invented terminal evidence. Remains unverified/partial.                                                                                           |
| PR-007 / 02                                                     | Real-agent semantic summary qualification after feedback, CI and maintenance; current quality-fact refresh alone is insufficient.                                                                                                                                                                              |
| TR-003 / 02; TR-004 / 01,03                                     | Added `run-orchestrator.test.ts` cases for repeated polls with only a Failed card, then mixed future/ineligible cards followed by each of Feature, Improvement, Bug and Refinement ahead of lower cards. Actual worker admission/authority creation is exercised; downstream processing is substituted.        |
| REF-001 / 01–03; REF-002 / 02–03; REF-003 / 01–04               | AUD-007: real-agent repository-grounding/template/scope samples needed. Read-only resumed postprocessing also needs a dedicated interruption/baseline fixture; do not replace engineering judgment with deterministic content heuristics.                                                                      |
| REF-005 / 03                                                    | Live attributable Trello duration/history qualification; absence of unavailable duration is intentional, not a defect.                                                                                                                                                                                         |
| IMP-001 / 03; IMP-002 / 01–02; IMP-003 / 01–02; IMP-004 / 02–03 | AUD-007: representative agent file/attachment use, scope, context and independent-review evidence. Session-separation call sites additionally merit deterministic dispatch assertions.                                                                                                                         |
| VAL-004 / 02–03                                                 | Additional composed advisory/primary outage and stop-proof scenarios. Unknown-running child safety waits are intentional; no automatic release correction is justified.                                                                                                                                        |
| HR-001 / 01,03; HR-003 / 02,04; HR-004 / 02; HR-006 / 04        | AUD-001 and AUD-002 corrections cover marker loss and sequential queue rollover. AUD-007 semantic actionability, supersession and adequacy of fix evidence still require real-agent samples; timing permutations need further modeled integration.                                                             |
| CI-001 / 01,03; CI-002 / 02,05                                  | AUD-003 now exposes mixed failures to repair admission. Additional full polling deadline and independent external-change episode scenarios remain needed; neither new SHA nor unit success proves a genuinely new trigger.                                                                                     |
| MNT-001 / 03; MNT-003 / 03                                      | Add approved-plus-outdated combined scenario; qualify supported legacy maintenance recovery. Unknown rebase provenance must remain fenced.                                                                                                                                                                     |
| REC-001 / 04; REC-003 / 04; CTX-004 / 03; CFG-002 / 02          | Additional simultaneous multiworker outage/manual-move plus deduplicated notification scenarios, then live token-expiry qualification. Sequential independent-project fixtures are not simultaneous evidence.                                                                                                  |
| REC-004 / 01–03; REC-006 / 03                                   | Need explicit unexpected-idle/progress-monitoring and safely terminalizable corruption scenarios. No verified arbitrary-idle defect was established; do not force terminalization of ambiguous external work.                                                                                                  |
| REC-005 / 02                                                    | Qualify actual supported upgrade versions using representative persisted fixtures; existing known-schema migration cannot attest all historical releases.                                                                                                                                                      |
| GIT-002 / 01                                                    | Real-agent generated-message quality and fallback descriptive adequacy need qualification; one-commit mechanics are already tested.                                                                                                                                                                            |
| GIT-006 / 03; CFG-005 / 04                                      | Supported operator recovery/legacy ambiguity scenarios and clarification of non-routine corruption boundaries. Preserving ambiguous work is intentional safety behavior, not permission to discard it.                                                                                                         |
| CFG-002 / 03                                                    | Live Trello Free resource/API qualification; no paid feature was introduced or required.                                                                                                                                                                                                                       |
| CFG-003 / 01                                                    | AUD-004 remains unresolved as described above; existing same-root tests do not qualify mis-mounted containers.                                                                                                                                                                                                 |
| CFG-004 / 01–02                                                 | Additional running-entry-point configuration-file edit scenario needed. Static one-time loading is not executed proof.                                                                                                                                                                                         |
| CFG-006 / 02                                                    | Additional enabled/disabled SMTP and App startup composition scenarios; do not introduce mandatory optional-service probes.                                                                                                                                                                                    |
| LOG-001 / 01; LOG-002 / 03                                      | AUD-005 removes the confirmed raw cleanup-output leak. Broader task-history rationale completeness still needs explicit assertions.                                                                                                                                                                            |
| SEC-001 / 01; SEC-002 / 01–02,04                                | No exhaustive repository-history secret attestation or unknown-secret guarantee. Retain finite registered-form/channel evidence and AUD-006 filesystem-exposure finding; additional synthetic input canaries are required for its correction.                                                                  |
| ENV-001 / 01; TST-001 / 04; TST-003 / 03                        | AUD-008: container mounted-storage, nested isolation, SIGTERM/restart and disposable live Trello/GitHub/OpenCode lifecycle qualification required. Not performed in this campaign; no live resources or credentials were used.                                                                                 |
| ENV-002 / 04,07                                                 | Added an exact absent-refinement-setup persistence/no-dispatch/baseline-reuse assertion in `refinement-setup-recovery.integration.test.ts`. Post-PR setup failure/timeout and implementation-specific skip composition still need coverage. General primary-operation recovery is not setup-specific evidence. |
| CTX-001 / 01; CTX-002 / 01                                      | Real-agent image/document/log use and repository-grounded clarification qualification, not canned output.                                                                                                                                                                                                      |
| CTX-003 / 01–02                                                 | Additional whole-lifecycle card-content snapshots and outcome-only comment-volume assertions needed; static mutation restrictions are not complete execution evidence.                                                                                                                                         |
| TST-001 / 02                                                    | New marker/rollover/mixed-CI/cleanup regressions improve coverage. Coordination, filesystem credentials and the composition scenarios above remain incomplete.                                                                                                                                                 |

The new selection fixtures initially timed out because their state root contained the simulated
repository/worktree roots. Diagnosed the explicit storage-separation error and corrected the fixture
to use disjoint roots; the focused four-case rerun passed. This was a fixture error, not a product
defect. The remaining groups are retained verification work, not reclassified as resolved merely
because validation passes. No live-service or real-model judgment qualification was performed.

## Integrated review corrections

The first integrated `yarn validate` passed lint, formatting and typecheck, but reported two failing
dispatch assertions (2,286 tests passed). Investigation found a bot reply fixture without explicit
bot-type metadata, and an old assertion requiring mixed CI failures to wait. Reserved GitHub `[bot]`
identities now remain excluded even without type metadata; human body markers still do not filter
feedback. The production CI projection now retains pending/missing names for failed evaluations. The
dispatch lifecycle regression exercises bounded repair with a permanently pending peer check; the
unknown-expectation case still consumes no repair attempts. Focused reruns passed: 7 feedback tests
and all 14 production-dispatch tests, plus typecheck and focused lint.

Final integrated validation/build and changes-mode audit results are reported in the delivery and
retained changes-audit artifacts under `.local/spec-audits/`. This status page does not supersede
the historical matrix or assert full compliance. AUD-004, AUD-006 and the remaining evidence gaps
above are open; this campaign is a partial remediation, not a release qualification.
