# Architecture agent contracts

Contract version: `phase-execution-v1`. The [execution protocol](phase-execution.md)
and repository instructions govern this project. Global OpenCode agents should
follow these responsibilities when operating here; record their actual file hashes
and permissions at launch because global files are not versioned by this repository.

| Role                       | Edits                                                                                                             | Commands                                                             | Responsibility                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Supervisor / phase-planner | Planning/evidence Markdown under `docs/`; implementation delegated                                                | Inspection, designated validation, explicitly authorized Git actions | Readiness, finite manifest, task boundaries, progress and acceptance decisions    |
| phase-implementer          | Assigned source/tests/task evidence; no supervisor-status changes unless explicitly assigned a documentation task | Focused checks; full validation only when designated runner          | One complete vertical candidate; negative controls; per-criterion truthful result |
| phase-reviewer             | None                                                                                                              | Read-only Git inspection; test execution not required or expected    | Independent code/assertion review and inspection of exact-tree runner artifacts   |

## Implementer return contract

- Complete the assigned source, callers, compatibility and decisive regression before
  returning a ready candidate. Do not stop because a needed fixture/helper is absent.
- Report each criterion as implemented/verified/incomplete/blocked, changed files,
  exact commands/results and readable evidence paths. A partial candidate is never
  automatically ready for acceptance review.
- Preserve unrelated work. No commit, push, merge, reset, rebase, branch change,
  destructive cleanup, production mutation or undelegated work.
- A genuine obstacle needs attempted approach, concrete limiting condition and next
  action. Do not conceal failed tests or classify engineering uncertainty as external.

## Reviewer contract

- Inspect assigned criteria, actual changes, caller/transition interactions and test
  assertions. A passing suite alone does not prove correctness.
- Accept designated-runner evidence after checking the exact revision/diff, command,
  complete output and assertions. No personal rerun is needed. Do not repeatedly
  request commands forbidden by role permissions.
- Keep code findings, validation status and owned-evidence completeness separate.
  If a log is absent/unreadable, request an accessible exact-tree artifact; do not
  manufacture a code defect or make denied personal execution a second gate.
- Block for a concrete current criterion defect, required owned evidence gap, or
  inherited safety regression. Name its path/evidence and minimal correction.
  Suggestions, later-owned variants and personal execution limits are separate.
- Correction review is delta-based. Reopen accepted findings only for new concrete
  evidence/regressions. Review the frozen complete manifest at final integration;
  do not invent an unbounded larger phase during that review.

Required response dimensions:

```text
CODE REVIEW: PASS | CHANGES REQUIRED
VALIDATION: PASS (runner evidence inspected) | FAIL | NOT RUN / EVIDENCE NEEDED
OWNED EVIDENCE: COMPLETE | PARTIAL | BLOCKED
DISPOSITION: ACCEPTED | CHANGES REQUIRED | BLOCKED FOR ASSIGNED SCOPE
Findings: criterion, concrete path/evidence, severity, minimal correction
Later-owned/nonblocking observations:
```

## Supervisor contract

Establish readiness, authorized Git scope and a readable runner channel first.
Dispatch one readable complete task, check its criterion checklist, then delegate
acceptance review. Do not ask for acceptance review of admitted missing work. Own
the status/manifest updates instead of asking an implementer to violate its role.
Use a diagnostic checkpoint after repeated incomplete returns on the same criterion.
One runner's passing evidence applies to the exact tree; do not demand duplicate
full-suite runs from all roles. Do not weaken required checks to reduce time.

Close only the selected gate. A user-closed milestone records carryovers without
falsifying evidence. Do not automatically reopen it, start another phase, or perform
unauthorized Git/release actions. Separate source-task acceptance, phase-owned
verification and full release qualification in every handoff.
