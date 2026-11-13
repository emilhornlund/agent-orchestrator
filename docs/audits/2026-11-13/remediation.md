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
