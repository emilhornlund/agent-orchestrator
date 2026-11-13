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
