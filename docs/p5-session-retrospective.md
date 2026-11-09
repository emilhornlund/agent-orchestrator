# P5 session retrospective and future-phase readiness audit

## Executive conclusion

**Follow-up:** the [execution protocol](phase-execution.md),
[readiness register](phase-readiness.md), [agent contracts](phase-agent-contracts.md),
and P6–P11 packets now implement this report's process/documentation corrections.
Unresolved product decisions and capability proofs remain explicit readiness tasks;
writing those documents is not evidence that the tasks or live checks passed.

The user subsequently approved the four concrete P6 recommendations in
[p6-decisions.md](p6-decisions.md). The P6 counted-unit/rubric/support/authorization
questions diagnosed here are therefore resolved as policy, while their executable
preflight and later-phase A2/A5 questions retain explicit owners.

The main failure was **using an architectural roadmap as an executable delivery
contract without first establishing readiness, phase-owned acceptance boundaries,
and a finite verification matrix**. The supervisor and custom-agent workflow
then amplified that planning failure through partial implementations, late
integration discovery, repeated verification-only review failures, and repeated
whole-phase re-audits.

This was not solely a documentation problem or a reviewer problem. Several
findings were real implementation defects. Others were foreseeable missing
resources or decisions. Still others were unfinished local tests incorrectly
grouped under “blocked.” Those categories required different responses.

The user's subsequent instruction that P5 is finished and should be published is
the onward-planning boundary for this retrospective. Historical review results
should remain historical evidence; outstanding technical work needs an explicit
carryover disposition, rather than silently reopening P5 or pretending every
verification level passed.

**P6–P11 have the same structural documentation risks. Their current roadmap
sections should not be handed directly to an implementer as sufficient task
specifications.** They need bounded execution packets and the targeted
clarifications below before their respective implementation starts.

## Scope and evidence

This analysis uses:

- The visible session: delegated prompts and returns, review findings,
  supervisor actions, validation failures, corrections, and publication.
- The branch's P5 history and documentation at `f8ac2ea`, published in PR #218.
- `docs/requirements.md`, `docs/specification.md`, `docs/verification.md`,
  `docs/implementation-audit.md`, and `docs/rewrite-plan.md`.
- The current custom-agent definitions in
  `~/.config/opencode/agents/phase-planner.md`, `phase-implementer.md`, and
  `phase-reviewer.md`.

The current agent files were inspected directly. There is no historical
instruction/model snapshot here proving that every invocation used precisely
these file contents. Observed permission denials and agent responses nevertheless
match important conflicts in these definitions. Model configuration alone is not
evidence that a particular model caused the failures.

There were 26 commits after the preserved WIP checkpoint `c0f3a8c`. The complete
phase diff from `765eeb6` spans 109 files, with 24,052 inserted and 925 deleted
lines, including tests and documents. That diff includes work predating this
continuation session; it is not a measurement of production code added by this
session alone. These numbers demonstrate the integration surface, not quality or
productivity.

## 1. What actually went wrong

### 1.1 Readiness was never established before implementation

The documents already identified prerequisites that could prevent the stated
completion contract from being met:

- `rewrite-plan.md:398–407` lists unresolved A2/A5 decisions and realistic-service
  authorization.
- `verification.md:13–18` explicitly requires disposable resources, credentials,
  and operator permission for realistic runs.
- `verification.md:1355–1366` identifies undefined semantic and progress oracles.
- P5's scope explicitly includes orphan-process reconciliation, but its assumed
  process-containment capability was not established at entry.

The supervisor started source tasks instead of first producing a readiness
disposition: what was decided, what could be tested locally, what required a
technical spike, and what required external authorization.

**Consequence:** known prerequisites appeared as late blockers after substantial
implementation. Their late discovery was avoidable even though the prerequisites
themselves were legitimate.

### 1.2 The roadmap and the phase completion contract did not align

`rewrite-plan.md:7` explicitly says the document is a proposed roadmap, **not an
implementation authorization or task backlog**. Yet it became the effective task
contract.

The plan permits incremental delivery at lines 18 and 261–265, but line 117 and
the traceability/completion rules require mapped scenarios at their stated
levels. There is no sufficiently precise intermediate acceptance definition
explaining which scenario variants are owned by the current phase, which are
regressions, and which require future phases.

Examples of forward dependencies in P5's assigned verification:

| Mapping               | Later functionality required by the complete scenario                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| P5 → `VER-WF-003-01`  | A configured global AI capacity of one; the capacity feature is introduced in P7.                       |
| P5 → `VER-PR-003-02`  | All advisory crashes proceed to meaningful publication; P6 owns replacement of advisory approval gates. |
| P5 → `VER-PR-003-03`  | A requested-change operation in Working and complete human terminal handoff; these also involve P7/P10. |
| P5 → `VER-CTX-002-01` | Clarification followed by a fresh clean requeue; fresh-attempt mechanics belong to P10.                 |
| P5 → `REQ-ENV-002`    | Its closure owner is P9, with P5/P6 support, although P5 was also tasked with broad setup verification. |

These are traceability/dependency problems, not reasons to remove the eventual
requirements. An earlier phase needs an explicit, approved slice of the eventual
scenario. Mapping the whole scenario and then saying “not later-phase scope” does
not specify that slice.

### 1.3 “Small tasks” were small labels around large integration obligations

R1 included all published correction phases, exact owning-operation continuation,
CI and feedback restart, both human terminal outcomes, and pre-PR preservation.
T3 included setup persistence, process recovery, two workflows, refinement
attribution, agent relevance, and commit safety. T4 combined model defaults with
clarification handling before later subdivision.

These were several interacting contracts, not consistently the smallest useful
vertical changes. Conversely, some delegated results implemented only a helper,
leaving its production callers and application-boundary tests unfinished.

**Correction:** a small task must name one observable production behavior, its
caller integration, and its decisive test. Splitting helpers from their necessary
callers creates partial work; bundling several independent workflows creates an
oversized task. Both extremes occurred.

### 1.4 Implementer incompleteness repeatedly became supervisor work

The implementer repeatedly returned variations of “implemented part; the required
workflow test or integration is not added.” Some invocations returned no changes.
The supervisor then had to reissue the same acceptance criteria, often several
times.

There was no effective return contract requiring each criterion to be reported as
implemented, verified, or blocked by a specific demonstrated obstacle. “No
existing helper” or “the test is missing” was allowed to function as a stopping
condition even when the task was to build that test.

The supervisor also requested review of incomplete candidates despite the
planner's instruction at lines 122–124 to wait until the assigned scope was
implemented and focused checks passed. That predictably produced findings for
work the implementer had already admitted was absent.

### 1.5 Integration contracts were implicit, and real defects appeared late

Several late findings were necessary corrections, not reviewer polish:

| Defect                                                                                      | Missing planning or integration contract                                                        |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Setup retry lost earlier unrelated changes from relevance candidates                        | Immutable original baseline versus per-attempt baseline.                                        |
| A valid setup correction was blocked by the new publication guard                           | Every initial/existing-PR publication consumer and its scope-proof contract.                    |
| Provider outage classification disappeared between result persistence and ledger completion | Crash-durable classification as part of execution evidence, not only an in-memory return value. |
| Reconstruction acknowledgement was fenced by the unresolved original primary operation      | Ordering between session reconstruction and original-operation evidence reconciliation.         |
| Published feedback restart expected the wrong Trello list                                   | Durable workflow ownership versus transient internal phase.                                     |
| A transition cleared completed feedback provenance                                          | Which fields remain authoritative across each transition.                                       |

P5 should have begun with a compact operation/state/evidence contract and caller
inventory. It was not possible to enumerate every bug in advance, but these
boundaries could have been made explicit before local implementations diverged.

### 1.6 The reviewer execution policy created avoidable approval loops

The current reviewer definition denies Bash generally and permits only selected
Git inspection commands (`phase-reviewer.md:11–16`). It also makes missing
verification evidence blocking and allows only PASS/FAIL (`68–92`). It does not
define an approved validation runner or explicitly distinguish independent code
review from personally rerunning tests.

Observed outcome: reviewers repeatedly attempted commands they could not run,
then sometimes returned FAIL solely because they had not independently executed
tests, even after finding no remaining code defect. The supervisor supplied logs
and requested another review. Later reviews correctly accepted retained
execution output without rerunning commands.

**The final behavior was sensible; it should have been the initial contract.**
Independent review of code and test assertions does not require independent
execution of every command. A trusted, revision-bound runner result can establish
execution evidence. If no such evidence exists, that is a validation status, not
automatically a newly discovered implementation defect.

### 1.7 Re-review was not reliably delta-bounded

The planner requires a new whole-phase review after corrections and repeats the
entire cycle (`phase-planner.md:129–147`). Whole-phase integration review was
valuable: it found defects scoped reviews missed. But the workflow did not define
when an accepted criterion could be reopened, how to separate a correction
regression from a previously unseen baseline issue, or when a new issue should
become a scope-change decision.

The result was a moving operational finish line. “One consolidated review” in
the backlog did not bound the planner's recursive whole-phase process.

Future correction review must verify the finding, its regression cone, and any
new concrete evidence. Final review must still cover integration, but should not
silently change the approved phase-owned acceptance matrix. A real newly found
safety defect still matters; bounded review is not permission to ignore it.

### 1.8 Validation policy and harness readiness were inconsistent

Three different expectations coexisted:

- Repository `AGENTS.md:76–84`: run `yarn validate` before finishing a change.
- Implementer definition `56–57`: supervisor handles full validation.
- P5 reusable task instruction `42–43`: full validation once after T2 fixes,
  rather than repeatedly for every focused activity.

The supervisor repeatedly asked implementers for full validation anyway, then
also ran validation itself. Reviewers sometimes demanded another evidence cycle.
Some reruns were justified by new code; some repeated already established facts.

Harness issues added noise: a 120-second tool deadline was shorter than successful
full runs, five-second test deadlines were too short for some subprocess-heavy
integration cases, a 50 ms nonzero-process fixture measured startup contention,
and `kill(pid, 0)` treated zombies as executing descendants. Container `TMPDIR`
also needed explicit configuration.

These should have been resolved by an executable preflight and a single
revision-bound validation ownership policy, rather than recurring as phase
implementation failures.

### 1.9 Prompts and progress documentation degraded as the session grew

Early task prompts were reasonably structured. Many later correction prompts
compressed multiple words and large acceptance matrices into dense blocks,
despite `phase-planner.md:112–115` explicitly prohibiting that style. The user
had also explicitly asked for small, well-structured prompts.

Four P5 documents accumulated current status, historical failures, repeated
disclaimers, old counts, and review distinctions. This preserved evidence but
increased the effort required to identify the current contract. The evidence map
was developed late as T5, when it was also needed to plan T1–T4.

One current status page, one task/decision ledger, and separately archived
execution records would have reduced context churn. Requirement and variant
mapping belongs at phase entry, then gets updated with execution results.

## 2. Why blockers were not caught early

| Item                                           | What was knowable before implementation                                                                                              | Correct early treatment                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing realistic-test authorization/resources | Explicit in verification protocol and roadmap decisions.                                                                             | Establish authorization and disposable resource availability, or approve a clearly separated implementation milestone and later qualification gate. |
| A2/A5 decisions                                | Explicitly listed as prerequisites for affected acceptance.                                                                          | Resolve only the decisions needed by the current phase, with named owner and concrete examples; do not leave a generic late “decision needed.”      |
| C2 containment/liveness                        | Orphan recovery was explicit; process-group supervision was the known mechanism. Escaped-descendant sufficiency was not established. | Run an early technical feasibility spike covering supervisor loss and descendant escape under supported local/container environments.               |
| Later-phase scenario prerequisites             | Visible from phase dependency and scenario precondition tables.                                                                      | Split ownership by criterion/variant and put final composition in its actual owner phase.                                                           |
| Reviewer cannot execute tests                  | Directly visible in its permission configuration.                                                                                    | Assign validation execution to one runner and define what evidence the reviewer accepts.                                                            |
| Partial production integration                 | Visible from task caller inventories and admitted incomplete returns.                                                                | Require complete acceptance rows before review; include one production-boundary regression per changed contract.                                    |
| C1/C5/C6 implementation defects                | Not necessarily predictable in exact code form. Their boundaries were predictable.                                                   | Specify cumulative provenance, shared-consumer contracts, and result-before-ledger crash barriers before implementation.                            |

### C2 was classified too broadly as an external blocker

The session established that **PID/process-group absence alone is insufficient**.
It did not establish that every viable containment or supervision mechanism is
unavailable. Calling it generally blocked on a “mechanism decision” obscured that
it was still an engineering feasibility/design task.

The appropriate next deliverable would have been a bounded spike with a concrete
result: a demonstrated compatible mechanism, or measured platform/permission/
dependency constraints explaining why each reasonable candidate is unsuitable.
Only an actual missing permission, unsupported target, resource, or required
product-policy decision justifies an external-blocker label. No unsafe retry
should be introduced while that investigation is incomplete.

### One policy drift is still visible in the documentation

`p5-progress.md:100–124` retains the A5 statement “three total primary-operation
executions including the initial execution.” The later C3 code separates total
executions, genuine failures, and dependency outages, allowing additional actual
executions across paced outage windows (`primary-operation-ledger.ts:129–144`).
The outage-preservation requirement explains why accounting needed refinement,
but the recorded policy and implemented budget taxonomy should have been
explicitly reconciled. Future phases must define the counted unit and reset
event for each budget before changing its consumers.

## 3. Custom-agent corrections

The initial audit proposed the instruction changes below. The subsequent
documentation follow-up implemented them in the global agent definitions and
[versioned project contracts](phase-agent-contracts.md). This table retains the
original diagnosis; current execution rules are in [phase-execution.md](phase-execution.md).

| Agent       | Current issue                                                                                                         | Required correction                                                                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Planner     | Starts implementation without a readiness/feasibility gate; whole scenarios are inherited without phase slices.       | Require an approved execution packet: entry baseline, owned variants, dependencies, external resources, decisions, and first runnable integration fixture.                                           |
| Planner     | Reviews admitted partial candidates; repeats whole-phase cycles without acceptance-change control.                    | Check the implementer's criterion checklist first. Re-review finding and regression cone. New scope requires explicit classification and disposition.                                                |
| Planner     | Generic technical uncertainty is reported as BLOCKED.                                                                 | Require an attempted spike and concrete limiting condition. Separate unfinished local work, implementation defect, external blocker, and decision blocker.                                           |
| Planner     | Dense correction prompts violate its own readable-prompt rule.                                                        | Enforce a short structured template; split independent corrections; include only the necessary context and exact observable result.                                                                  |
| Implementer | Its return contract permits a concise partial summary without clearly requiring completion or a demonstrated blocker. | Require IMPLEMENTED / VERIFIED / BLOCKED per acceptance row. Missing helpers or tests are work to perform, not a blocker. No readiness-for-review claim with an admitted missing assigned criterion. |
| Implementer | Forbidden to modify supervisor progress while prompts repeatedly ask it to update progress documents.                 | Give one role explicit ownership of current planning/status documents. Authorize task evidence updates separately and consistently.                                                                  |
| Reviewer    | Cannot run tests but sometimes demands personal execution as a condition of PASS.                                     | Review code independently; accept authorized runner artifacts bound to the exact tree. Report personal execution as not performed without inventing a code defect.                                   |
| Reviewer    | PASS/FAIL collapses code review, validation availability, evidence completeness, and phase acceptance.                | Report separate dimensions: code findings, runner validation, owned-scenario evidence, and final scope disposition. Lack of optional personal rerun is not missing required evidence.                |
| Reviewer    | Every medium issue blocks without distinguishing approved scope, uncertainty, and current-task regression.            | Blocking findings must name an owned criterion or concrete inherited safety regression, evidence/path, and minimal correction. Suggestions and future-phase observations are tracked separately.     |
| All roles   | Local agent definitions are not version-pinned in the phase record.                                                   | Record instruction revision/hash, tool permissions, and effective role configuration at phase start. Do not infer model causation without comparative evidence.                                      |

Also reconcile Git authority: the planner tells itself to commit each completed
task, while repository `AGENTS.md:108` requires explicit task authorization.
Phase launch instructions must state the allowed Git actions. This is a
configuration/governance conflict, not the main explanation for the review loops.

## 4. P6–P11 readiness audit

The following are concrete pre-implementation corrections to the existing
roadmap. They preserve intended behavior; where a product decision is needed,
that decision must be made explicitly rather than inferred by an agent.

### P6 — Advisory implementation and truthful publication

**Risks in current documentation:**

- `rewrite-plan.md:179` maps all of PR-007's scenario, but
  `VER-PR-007-01` requires feedback, CI, and maintenance description refreshes
  belonging to P7/P8.
- `VER-CTX-002-01` includes clean explicit requeue, assigned to P10.
- Source-checkout protection at `rewrite-plan.md:173` requires enforceable
  permissions/execution boundaries without naming or demonstrating a feasible
  supported mechanism. The audit already warns that cwd/prompt rules are not a
  sandbox. This is a direct candidate for another late C2-style feasibility issue.
- “Meaningful,” “material unresolved,” early finish, no-op, unconfigured checks,
  and draft readiness need one typed evidence/disposition contract. Some are
  already settled behavior; they need faithful executable examples, not reopening
  the settled advisory policy.

**Before P6 starts:**

1. Assign initial PR body/readiness to P6; feedback/CI/maintenance body variants to
   their respective later owners. Retain the full final scenario mapping.
2. Demonstrate the chosen original-checkout protection boundary with a negative
   write test before building the publication policy around it.
3. Define optional-command outcomes, advisory error outcomes, no-op comparison
   identity, and each improvement budget's counted unit/reset event.
4. Give every shared publication consumer a compatibility contract for preserved
   setup exclusions, primary-recovery evidence, and existing-PR corrections.
5. Specify which A2 examples are needed now and arrange any required live gate.

### P7 — Observation, scheduling, and human feedback

**Risks:** This phase combines concurrent observation, serialized mutation,
durable queueing, global capacity/fairness, semantic feedback classification,
Trello transitions, PR presentation, and terminal cancellation. It is several
architectural deliverables. A2/A5 decisions affect semantic requests and polling
boundaries. The complete terminal scenario overlaps P10, and routine maintenance
in queue tests may need P8 behavior not implemented yet.

**Before P7 starts:**

1. Define observer/writer authority and generation/fencing rules, including what
   observations may be persisted during a running mutation and after cancellation.
2. Specify the AI slot's unit/lifetime and durable FCFS arrival/release semantics;
   distinguish nested advisory work, waits, and project occupancy.
3. Define the feedback classification result and representative substantive,
   cosmetic, deleted, superseded, self-authored, and exhausted-request fixtures.
4. Migrate P5's published-correction expected-list contract deliberately when
   changing Human Review to Working. Do not key recovery solely to internal phase.
5. Use queued maintenance descriptors to test ordering without requiring P8's
   complete branch-maintenance execution. Assign terminal observation/fencing to
   P7 and final cleanup/requeue variants to P10 explicitly.

### P8 — CI episodes and additive maintenance

**Risks:** A5 explicitly leaves expected-check discovery and bounds unresolved.
“Materially new independent failure” is semantic, yet the plan does not specify
the validated judgment/evidence contract. Episode budgets must survive changed
SHAs, restart, and target merges. Preserved dirty setup output can conflict with
maintenance assumptions about a clean worktree.

**Before P8 starts:**

1. Define expected-check sources and supported CI cases, precedence, observation
   start/end times, and uncertain-result treatment with approved fixture bounds.
2. Define episode identity, verified new-trigger evidence, judgment ownership,
   accounting, reset/retirement, and legacy episode migration.
3. Specify merge/conflict/push behavior when unrelated reviewed setup changes or
   unshipped corrections remain present; preservation cannot become a blanket
   stage-all or clean-worktree gate.
4. Freeze a finite real-Git ancestry/conflict/remote-race matrix and arrange
   realistic discovery/repair checks before their completion gate is due.

### P9 — Recoverable, read-only refinement

**Risks:** A2 templates, attachment support, and human grounding/scope assessment
are still unresolved. The plan relies on available Trello change history and
conservative race detection, but no concrete supported history/capability
contract is supplied. P5 still permits a legacy in-worktree result exception;
P9 moves outputs outside the worktree and must migrate the baseline contract.

**Before P9 starts:**

1. Approve representative templates, supported attachment fixtures, and a small
   grounding/scope rubric. Exhaustive semantic classification is not feasible.
2. Probe the required Trello Free history/readback capabilities and permissions;
   specify pagination, unavailable history, and unattributable edits.
3. Define the field-update/compensation state machine, evidence needed for each
   write, and the operator-resolution path when safe attribution is impossible.
   Preserve the existing explicit acknowledgement that read-before-write is not
   atomic conditional mutation.
4. Define external output ownership and migration of P5's result-file baseline
   exemption, including interrupted old refinement attempts.
5. Assign successful verified refinement release to P9 and historical-artifact
   cleanup/fresh retry to P10 at the variant level.

### P10 — Terminal artifacts, cleanup, and deliberate retry

**Risks:** Cross-phase terminal behavior is scattered; supported upgrade versions
and resource provenance are underspecified. Closed-PR history accessibility and
deleted remote branches are provider-dependent. Preserved setup output and
clean-but-unshipped commits require explicit proof before deletion or archival.

**Before P10 starts:**

1. Publish one terminal-ownership table: required workflow effects, uncertain
   in-flight effects, notification-only uncertainty, deferred cleanup, and exact
   release ordering.
2. Define the resource manifest and reachability proof for dirty changes,
   local-only commits, closed-PR history, and already-absent resources.
3. Establish the supported prior-version cohort and actual artifact fixtures;
   “earlier versions” cannot mean an open-ended historical set.
4. Define archive/new-attempt handoff and crash barriers so an explicit retry is
   clean while prior unfinished code and setup output remain preserved.
5. Probe closed-PR accessibility and deletion variants in disposable repositories;
   inaccessible evidence must preserve resources rather than become cleanup success.

### P11 — Lifecycle evidence and release closure

**Risks:** It inherits all requirements, all variants, local/container parity,
actual upgrades, live providers, auth combinations, and semantic assessments.
Without a frozen release matrix it can become the same endless phase on a larger
scale. It also says to resolve A2/A5 here even though earlier phase gates require
those decisions; only explicitly deferred residual decisions can wait until P11.

**Before P11 starts:**

1. Ensure earlier required decisions were actually resolved when needed; define
   exactly which residual decisions remain for release.
2. Freeze a finite requirement/criterion/variant/environment matrix, identifying
   reusable evidence, mandatory full combinations, and justified combination
   coverage. Preserve every explicitly required scenario variant; do not silently
   replace full obligations with pairwise tests.
3. Provision and authorize the live environment, test identities, Free-plan
   resources, inbox, model access, prior/current artifacts, and container volumes.
4. Define release qualification separately from source-task completion, and
   distinguish application failure, fixture failure, unavailable environment,
   and unexecuted test outcomes.
5. Specify supported upgrade paths and exact legacy-dispatch retirement evidence
   so “retire remaining compatibility” is not an unbounded cleanup instruction.

## 5. The required execution packet for each future phase

Keep the roadmap as the roadmap. Add one short, versioned execution packet per
phase, with these required sections:

1. **Objective and explicit non-goals.** Identify the production workflow being
   changed and future-phase work that is not part of this gate.
2. **Pinned entry baseline and carryovers.** Include accepted earlier milestones,
   known limitations, and a disposition for each: prerequisite, owned task,
   accepted deferred issue, or release gate. Do not reopen P5 by implication.
3. **Readiness table.** Technical capability, decision, environment, or permission;
   exact owner; evidence required; due-before task; status and next action.
4. **Phase-owned acceptance matrix.** For each requirement AC and scenario
   variant: current owner, later composition owner, required level, executable
   command, fixture, observer assertion, and expected evidence location.
5. **State/evidence contracts.** Operation identity, role, counted unit, dispatch
   proof, result durability, retry/recheck semantics, session binding, transition
   fields, publication scope, and schema migration.
6. **Ordered vertical tasks.** One observable production behavior per task with
   necessary caller integration and one decisive regression. Each task must fit
   the available test harness, or explicitly include a small harness prerequisite.
7. **Validation and review ownership.** Authorized runner, revision-bound evidence,
   focused versus full checks, tool deadlines, and review-delta rules.
8. **Completion levels.** State exactly what source-task acceptance, phase-owned
   acceptance, and release qualification mean. Missing required evidence remains
   missing; a separately approved milestone must not claim full compliance.

Example of the required granularity:

| Item                                                     | Current owner               | Later composition owner                      | Acceptance boundary                                                      |
| -------------------------------------------------------- | --------------------------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| REQ-PR-007 AC1, initial generated description            | P6                          | P11 live lifecycle                           | Initial publication body reflects implementation and recorded checks.    |
| REQ-PR-007 AC2, feedback refresh                         | P7                          | P11                                          | Actual feedback correction updates the same PR body.                     |
| REQ-PR-007 AC2, CI/maintenance refresh                   | P8                          | P11                                          | CI and target-merge corrections refresh current evidence.                |
| REQ-CTX-002, clarification decision and verified failure | P5/P6 baseline contribution | P10 requeue; P11 semantic/live qualification | Do not require clean fresh-attempt mechanics before P10 implements them. |

This table is a proposed ownership correction, not an unapproved amendment to
the authoritative acceptance baseline.

### Structured task prompt

```text
Task: <one production behavior>
Baseline: <commit and allowed existing work>
Requirements: <owned ACs and precise scenario variants>
Context: <caller/state/evidence contracts and known constraints>
Implement: <necessary source and caller integration>
Verify: <one decisive application-boundary case plus boundary controls>
Commands: <exact focused and required full validation commands>
Out of scope: <specific later-phase variants>
Return: criterion checklist, changed files, runner evidence, concrete blocker
```

A blocked return must identify the exact missing capability, decision, resource,
or permission, what was attempted, the observed limitation, and the smallest
action that would unblock it. An admitted unimplemented local test is not an
external blocker.

## 6. Prioritized corrections before the next implementation starts

| Priority | Correction                                                                                                                        | Acceptance check                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| P0       | Create the P6 execution packet and assign all inherited forward-dependent variants.                                               | No P6 completion row requires unimplemented P7–P10 behavior. Eventual requirements remain assigned.                                |
| P0       | Dispose of P5 carryovers explicitly, including C2, without reopening the finished milestone by implication.                       | Every carryover has an owner, prerequisite/deferred/release classification, and concrete next action.                              |
| P0       | Run technical feasibility checks for the chosen source-checkout boundary and decide the necessary execution-evidence assumptions. | Actual negative test and supported local/container capability evidence exist before dependent implementation.                      |
| P0       | Resolve current-phase A2/A5 decisions and live-test authorization before promising their evidence gate.                           | No required current gate has an unknown oracle or unavailable resource without an explicit approved milestone boundary.            |
| P0       | Reconcile planner/implementer/reviewer permissions and evidence ownership.                                                        | One tiny trial task completes implementation → runner → read-only review without a permission-only FAIL loop.                      |
| P0       | Reconcile primary-work, outage, reconstruction, service-request, validation, review, and CI budget terminology.                   | Every budget states counted unit, limit source, retry eligibility, reset event, and migration behavior consistently.               |
| P1       | Make all next-phase task acceptance rows ready before first source dispatch.                                                      | No row says only “all scenarios” or leaves required executable coverage to a final mapping task.                                   |
| P1       | Require caller/transition contracts and complete candidate checklists.                                                            | Shared-helper changes identify every consumer; partial helpers do not reach review as ready candidates.                            |
| P1       | Establish bounded, delta-based remediation and scope-change handling.                                                             | A resolved criterion reopens only for a documented regression/new concrete evidence, not reviewer personal rerun restrictions.     |
| P1       | Standardize sanitized runner artifacts and realistic fixture preflight.                                                           | Artifacts identify tree, command, environment, timeout, exit status, scope, and output; reviewer can read them within permissions. |
| P1       | Separate current status from historical evidence.                                                                                 | One current milestone/decision ledger links immutable past records; old counts or pending-review claims cannot override it.        |

## Final assessment

The authoritative requirements and safety distinctions are valuable. The answer
is not to discard them, silence reviewers, or label unexecuted evidence passed.
The answer is to make their **delivery ownership, technical feasibility,
authorization, and finite phase acceptance** explicit before implementation.

The supervisor bears responsibility for starting without that preparation,
reviewing incomplete candidates, allowing evidence-permission loops, degrading
prompt structure, and reporting unfinished engineering together with external
blockers. The implementer and reviewer contracts also need correction so the
supervisor does not have to reconstruct those rules through repeated follow-up
prompts.

These corrections can substantially reduce repetition and late surprises.
They cannot guarantee zero ambiguity or zero new defects. The practical target
is that unresolved decisions and infeasible assumptions are found at phase entry,
ordinary defects are caught by small production-boundary tasks, and no phase
acquires a new undefined finish line during its final review.
