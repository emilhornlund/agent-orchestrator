# Architecture phase execution protocol

## Authority and entry points

Product behavior: [requirements](requirements.md) → [specification](specification.md).
Evidence obligations: [verification](verification.md). Architecture and sequencing:
[roadmap](rewrite-plan.md). This protocol governs delivery mechanics, not product
requirements. Packets partition delivery ownership; they cannot weaken an invariant,
approve an unexecuted scenario, or invent a product default.

| Document                                                                | Purpose                                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [Current milestone](phase-status.md)                                    | One current status, baseline and carryover disposition                               |
| [Readiness register](phase-readiness.md)                                | Decisions, technical spikes, resources and permissions with owners/due dates by task |
| [P6](p6-execution.md), [P7](p7-execution.md), [P8](p8-execution.md)     | Initial publication, feedback/scheduling, CI/maintenance packets                     |
| [P9](p9-execution.md), [P10](p10-execution.md), [P11](p11-execution.md) | Refinement, terminal/retry, release qualification packets                            |
| [P5 retrospective](p5-session-retrospective.md)                         | Rationale and observed failure modes; not a new acceptance authority                 |
| [Agent contracts](phase-agent-contracts.md)                             | Implementer, reviewer and supervisor responsibilities                                |

## 1. Readiness before dependent implementation

For P6, the four user decisions are approved in [p6-decisions.md](p6-decisions.md).
Do not repeatedly request those approvals; finish their engineering evidence and
resource checks. Approval of the isolated live scope is not approval of production
access, purchases, deployment or the current project PR's merge.

Start the packet's readiness tasks immediately; unknown readiness is not permission
to stop all work. Before each dependent source task, the supervisor records:

1. Actual base commit and working-diff inventory; selected branch; user-authorized
   Git actions. Never assume that a closed milestone is merged or fully qualified.
2. Applicable requirements/ACs, packet-owned variants, and later composition owners.
3. Required technical capability demonstrated by a bounded spike, with a negative
   control where safety depends on refusal. A prose claim is not a capability proof.
4. Needed product decisions, approved representative fixtures, configuration bounds,
   disposable resources and authorization. Never inspect private credentials merely
   to determine whether authorization exists.
5. A runnable integration fixture and independent observation boundary. If missing,
   make the smallest harness prerequisite a task, rather than review a helper-only
   implementation as if integration were done.
6. Effective agent contract/version, tool permissions, validation runner and readable
   evidence location. Check this once with a small task, not after many denied runs.

Readiness states: `OPEN` (local work/decision pending), `READY`, or `BLOCKED` with
demonstrated limiting condition and next action. Only dependent tasks wait. A failed
spike is a useful result, not evidence that all possible approaches are impossible.

## 2. Freeze a finite criterion/variant manifest

Create `docs/phase-records/P<N>-manifest.md` at launch. This is the current phase's
execution record; the packets below are planning contracts, not executed results.
For each packet-owned row, list:

| Field          | Required content                                                                 |
| -------------- | -------------------------------------------------------------------------------- |
| Identity       | Stable REQ/AC and existing VER ID plus a local variant label                     |
| Ownership      | Current implementation task and final composition/qualification owner            |
| Preconditions  | Published/unpublished, workflow, state/schema and configured bounds              |
| Fault boundary | Intent, dispatch, acceptance, response, result/ledger, transition, as applicable |
| Environment    | Unit, integration, simulated E2E, realistic; local/container where required      |
| Execution      | Exact command/test name or authorized run procedure and observer assertions      |
| Outcome        | Passed, failed, blocked, partial/not executed; actual evidence reference         |

Enumerate the variants explicitly required by the canonical scenario. Do not silently
omit one, require a later-owned workflow prematurely, or multiply every unrelated
dimension into an unbounded Cartesian matrix. Shared runs may establish several
rows when their assertions actually cover them. A helper test plus a caller-wiring
test may be sufficient for a local regression; neither becomes a complete lifecycle
pass without the required composition observations.

A newly discovered requirement/variant gets a written disposition: current owned
criterion, inherited safety regression, later owner, or proposed scope change. The
supervisor cannot waive product behavior or relabel unexecuted evidence passed.

## 3. Small, complete vertical tasks

One task changes one observable production behavior. Include necessary callers,
persisted-state handling and its decisive regression together. Separate independent
workflows; do not split a helper from integration needed to make it usable.

Use this prompt without compressed words or large unrelated acceptance bundles:

```text
Task: <one observable behavior>
Baseline: <commit, allowed current diff, branch>
Owned acceptance: <REQ/AC, VER variants and evidence level>
Context: <callers, state/evidence contract, prerequisite results>
Implement: <necessary source + caller integration + compatibility>
Verify: <decisive production-boundary case and negative controls>
Commands: <focused checks; full validation runner/ownership>
Boundaries: <specific later variants and unrelated work>
Return: per-criterion checklist, files, evidence, concrete remaining obstacle
```

Implementer return states per criterion: `IMPLEMENTED`, `VERIFIED`, `INCOMPLETE`,
or `BLOCKED`. An absent helper/test is usually work to perform, not a blocker.
Do not request acceptance review of an admitted incomplete candidate. An explicitly
requested design consultation is separate from acceptance review and has no PASS gate.

## 4. Integration contracts required for shared changes

Before changing a shared runner, transition, publisher or store, record its callers
and these applicable contracts in the manifest/task:

- Semantic operation ID, generation/lease, session binding and dispatch evidence.
- Per-execution fields versus cumulative history; counted unit, limit source, refund,
  accounting point, retry eligibility, paced wait, reset and migration semantics.
- Immutable original baseline versus per-attempt effects and live-content proof.
- Expected external state by durable workflow owner, not just transient phase name.
- Fields retained/cleared by transitions and which recovery path consumes them.
- Result/classification persistence before ledger completion; cached-result adoption.
- Initial versus existing-PR publication, setup exclusions and unshipped-work handling.

Unknown external acceptance or process liveness never authorizes another writer.
No task-wide deadline, generic provider abstraction, paid-only integration, automatic
merge, force-push, or destructive cleanup is introduced by this protocol.

## 5. Validation execution and evidence

The implementer runs focused tests. The supervisor runs `yarn validate` or explicitly
designates a runner. Run full validation once for the final integrated candidate of
the change; reuse that successful result for the same tree. Rerun after code/doc
changes required by the repository's checks, a failure, or a specific unresolved
concern. Do not duplicate full runs merely because a reviewer is read-only.

Use a tool deadline long enough for the actual suite (the P5 full run needed more
than 120 seconds). A tool deadline is not the application's operation timeout.
Timeout/permission failure is not passing evidence and must not be called a product
defect without diagnosis. Fix faulty fixture timing/oracles without weakening product
assertions; retain the failed result and the reason for the correction.

Run ordinary `yarn test` without manual temporary-directory setup. Vitest owns and
cleans its per-run system-temporary directory, including process artifacts. Do not
add rewrite-specific test commands, live probe scripts or permanent fixture archives.
Earlier `.p5-tmp` paths and removed rewrite harnesses are historical records only;
they are not prerequisites for current checks. Preflight process startup allowances
separately from deliberately short timeout fault cases.

Retain a concise tracked result summary and, when needed, sanitized command output.
Do not preserve disposable fixture trees, process artifact directories or downloaded
dependency trees for phase acceptance. Rewrite evidence must not become a permanent
application subsystem. Record:

- Base commit, tracked diff hash and hashes of any untracked candidate files; the
  later commit SHA if committing is authorized. Include global agent revisions.
- Exact command, cwd, effective non-secret environment/configuration and fixture
  revision, start/end time, tool deadline, exit status and complete output paths.
- Scope and level actually demonstrated, independent assertions and remaining gaps.

The reviewer independently inspects code/assertions and this evidence. Personal
reviewer execution is optional, not a separate required qualification level. If the
evidence tree does not match, request the runner's missing result once; do not invent
a code finding or rerun denied commands. Never accept merely a test-count claim.

## 6. Review and remediation without a moving finish line

Report separate dimensions: `CODE REVIEW` (pass/changes required), `VALIDATION`
(pass/fail/not run), `OWNED EVIDENCE` (complete/partial/blocked), and `DISPOSITION`
(accepted/changes required/blocked for the assigned scope).

A blocking finding names an owned criterion or concrete inherited safety regression,
the failing path/assertion, evidence and minimal correction. A severity label alone
does not expand scope. Suggestions and later-owned observations are nonblocking for
the current task and remain tracked. Missing current owned verification is not
optional merely because code looks correct.

Consolidate related findings into one readable correction task. If two correction
returns still miss the same assigned criterion, pause the acceptance loop for a
specific fixture/contract diagnosis; fix the prompt, dependency or task size before
repeating it. This diagnostic checkpoint is not a product retry limit or a waiver.

Re-review the finding and its regression cone. Reopen an accepted row only with
concrete new evidence or an introduced regression. After tasks finish, perform one
independent whole-phase integration review against the frozen owned manifest and
combined diff. Corrections receive delta review; repeat full-phase inspection only
when they change a cross-task contract or create a concrete unresolved integration
concern. Such a repeat must name that concern, not automatically restart all audits.

## 7. Milestone, qualification and handoff

- **Task accepted:** assigned behavior, compatibility and focused evidence are done;
  required runner validation and code review pass.
- **Phase-owned acceptance:** all owned manifest variants at their required levels
  pass, no current blocking defect remains, and integration review passes.
- **Release qualified:** P11's complete product/lifecycle/environment matrix passes.
- **User-closed delivery milestone:** an explicit user decision to stop/publish a
  phase with identified carryovers. Record that decision without claiming missing
  verification passed or automatically reopening the milestone in the next phase.

An implementation-only checkpoint with missing required realistic evidence must be
labeled as such, not phase-qualified. A changed milestone boundary requires explicit
user agreement. Arrange required live checks before their owned gate, not at the end.

Commit, push and PR creation require explicit task authorization. If commits are not
authorized, retain a diff-bound accepted candidate and report Git handoff pending;
do not demand a clean tree by discarding it. When commits are authorized, inspect
status/diff/log, stage intended files only, and record the checkpoint. Stop at the
selected phase; never automatically merge, deploy, or start another phase.

Current status belongs in [phase-status.md](phase-status.md) and the launched
manifest. Keep immutable historical run details in evidence records rather than
copying contradictory current counts into multiple documents.
