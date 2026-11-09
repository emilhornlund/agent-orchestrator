# Agent Orchestrator — Verification Plan

## Status and authority

This plan defines verification scenarios for [requirements.md](requirements.md) and [specification.md](specification.md). It is not an execution record or an implementation audit. Scenarios are specifications for future demonstrations; **their inclusion here does not establish that they have been executed or passed**. Formatting, traceability and document checks are not behavioral evidence.

The requirements document governs intended behavior. The specification supplies the existing requirement IDs and acceptance criteria. This plan neither changes those sources nor adds product requirements. Source tensions and unresolved test oracles are recorded under [Ambiguities and decisions needed](#ambiguities-and-decisions-needed).

### Use by an implementation phase

Use the [execution protocol](phase-execution.md), [readiness register](phase-readiness.md),
and selected P6–P11 packet before source work. The canonical scenarios below describe
eventual complete behavior. Referencing a scenario does not assign every later-workflow
variant to the current phase. Packets assign each applicable criterion/variant to an
implementation owner and a final composition owner. Preserve the full scenario and
its evidence levels; later-owned variants remain unexecuted, not passed.

At readiness, expand each owned scenario row into a finite manifest of the variants
actually required by its Steps and inherited fault boundaries. Record applicability
and reasons for excluded dimensions; do not silently delete explicitly required
variants or generate an unspecified Cartesian product. A new required combination
discovered later needs a documented scope/dependency disposition, not an implicit
change of the current task's acceptance criteria. Concrete safety regressions remain
blocking even if the original manifest missed them.

Execution evidence may be supplied by the designated runner and independently
inspected by a read-only reviewer. Bind it to the exact tree/diff, command, environment,
exit status, assertions, and evidence level. Personal reviewer execution is not a
second mandatory evidence level. Unit, integration, simulated lifecycle, and realistic
results must still be distinguished. An unavailable runner is a validation/resource
status, not by itself an implementation defect.

## Execution protocol and shared fixtures

### Levels and environments

- **Unit:** Deterministic decisions, parsing, validation, transitions, limits, and scheduling, using controlled clocks and inputs. Unit evidence is supplementary to observed workflow behavior.
- **Integration:** Run the orchestrator with real local Git repositories, worktrees, processes, filesystem storage, and independently inspectable deterministic Trello, GitHub, OpenCode, and email substitutes as applicable. Substitutes maintain resource state and an append-only request ledger; they must model accepted-but-unacknowledged writes, outages, delays, and restarts, not merely return canned success messages. Routine tests must be runnable without live external services.
- **End-to-end (simulated services):** Drive a complete task lifecycle through the application boundary with the integration fixtures. Keep actual Git and process execution. This establishes workflow behavior under reproducible conditions, not live API compatibility.
- **End-to-end (realistic):** Use disposable real Trello Free boards, GitHub repositories and PRs, OpenCode sessions, and a controlled email destination when enabled, with actual commands and Git operations. Record service identities and versions. These runs require isolated credentials, operator permission, and an isolated test environment, which may be temporary; a permanent dedicated environment is not a prerequisite to robustness work. Never use production cards or repositories. A container run must exercise Docker-compatible deployment behavior; Podman may run that environment on hosts using Podman, with the runtime recorded.

Every scenario declares its level. Scenarios marked realistic require the stated external integration; substitutes alone cannot establish those claims. A failed live dependency is recorded as an environment blockage or outage, not silently converted into a passed scenario.

### Common fixture F

Unless overridden, each complete scenario starts from a fresh, isolated fixture F.
A task-level slice may use a smaller fixture only when its packet explicitly names
the observations it can establish and the owner of the remaining composition. Such
a slice is not a pass for the complete scenario:

1. Two independently configured projects, A and B, each with its own board, all required lifecycle lists, disposable repository, GitHub repository, runtime directory outside all repositories, and log directory. Each board contains uniquely tagged cards and at least two eligible cards in known order. Exercise `Feature`, `Improvement`, `Bug`, and `Refinement` where specified. No previous ownership exists.
2. A real Git source checkout, bare remote, and default branch with identifiable source, tests, configuration, and documentation. Record source checkout HEAD, refs, status, tracked/untracked file hashes, and remote refs. Include unrelated dirty files and an unrelated worktree in safety scenarios. Agent execution uses a separate owned worktree and branch. Shared Git metadata may legitimately contain the new task branch/worktree; source-checkout protection means its checked-out branch, HEAD, index, files, and preexisting unrelated refs/work are not changed by task execution.
3. A meaningful task with independently checkable expected changes, plus attachment fixtures: an image containing a distinctive label, a document containing a task fact, and a log identifying an error. Fixture manifests record expected content and revisions. Use supported formats once that support contract is known (A2).
4. Scriptable agents that can inspect context, produce known file edits, retain session identities, decline advice, emit malformed output, crash, or hang. Independent reviewers use distinct session identities. Agent declarations alone never satisfy file, validation, or workflow assertions.
5. Executable setup, validation, and coverage fixtures that record invocation, working directory, environment variable names, start/end times, exit status, and configurable stdout/stderr; hanging commands spawn a descendant process. Avoid recording actual secrets in the invocation ledger.
6. Explicit test values for all applicable configured attempt limits, operation timeouts, CI waits, and polling/backoff behavior. Record their effective values before execution. Use unequal small positive limits for separate correction policies; exercise zero only if the agreed configuration permits it. A controlled clock accelerates routine tests; realistic runs use measured wall time. Do not turn fixture values into product defaults.
7. An independent observer reads Trello cards/comments, GitHub PRs/reviews/checks, Git refs/objects/diffs, process liveness, persisted execution state, session requests, and email deliveries. Capture baseline counts and identities before action. The observer must not infer success from an agent response or a log saying an operation succeeded.

### Repeatability, failures, and evidence

For each parameterized scenario, execute every listed variant independently from its stated initial state. Restore fixture state between variants. Record exact commands/API actions, sanitized effective configuration, fixture revision, injected fault, application version, environment, timestamps, and observed results so another operator can repeat it. This plan intentionally specifies behavioral actions rather than current implementation commands or storage schemas; the execution record must bind those actions to the tested version's public invocation and inspection interfaces.

For mutation/recovery scenarios, interrupt at each applicable boundary: before dispatch, after external acceptance but before response, after response but before durable recording, and after durable recording but before the next step. Use both process termination and restart where specified. Reconcile against independently read external resources and preserved local artifacts. Check counts and stable identities of PRs, commits, comments, notification events, transitions, and sessions as applicable, not just the final card list. Retrying a failed read must not be treated as evidence that a resource is absent.

Observe forbidden behavior over the whole execution, including recovery: inspect mutation ledgers, Git ref history, process intervals, and outbound payloads. A clean final state cannot conceal a transient unsafe write, duplicate effect, concurrent branch mutation, unauthorized merge, or secret disclosure. Keep the oracle's sensitive-data scan results sanitized.

Distinguish these outcomes in execution records:

- **Passed:** All stated observations and required evidence agree, including negative assertions and bounds.
- **Failed:** An observed result contradicts the expected behavior; include the first divergence and retained state.
- **Blocked:** Environment or a documented unresolved oracle prevents a conclusion. Record the dependency or decision needed.
- **Partial / not executed:** Identify missing variants, assertions, levels, or evidence. Never report the parent requirement as fully demonstrated by a subset.

An expected product failure such as confirmed `Failed` after an unrecoverable primary crash can pass a failure-handling scenario. An unexpected orchestrator crash, lost evidence, or external outage cannot be called that expected failure without the scenario's classification and reconciliation evidence.

For bounded scenarios, measure attempt counts, elapsed waits, child-process termination, retry delays, and state transitions against the recorded configuration. Observe several polling/recheck windows after a cycle ends to detect repeated work; advance the clock through further windows to verify controlled waiting. A finite observation alone is insufficient to prove no loop: pair runtime traces with deterministic limit/transition tests at the boundary. No overall task deadline is inferred.

A single recorded run may supply evidence for multiple overlapping scenarios if it satisfies each one's preconditions, variants, levels, and assertions; link the shared evidence explicitly rather than repeating identical runs. Domain scenarios isolate failures, while complete lifecycle scenarios establish that the behaviors compose.

### Traceability convention

In each requirement section, **AC1**, **AC2**, and so on refer to its acceptance-criterion bullets in specification order; these are local traceability labels, not new requirement IDs. Each scenario's **Coverage** explicitly maps those criteria. Shared coverage names the additional requirement and its local acceptance criteria explicitly; the requirement index includes those shared scenarios as well as scenarios in the requirement's own section. Common fixtures and this protocol are inherited preconditions, steps, and evidence obligations, in addition to each scenario's explicit fields.

## Workflow progression (REQ-WF)

### REQ-WF-001 — Verified state transitions

**Requirement ID:** REQ-WF-001

#### VER-WF-001-01 — Reconcile uncertain external mutations

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; pending Trello move or GitHub PR creation/update, with write acceptance independently observable.
- **Steps:** For each service, inject rejection, timeout before acceptance, and lost response after acceptance. Restart at the mutation boundaries, then restore reads and allow reconciliation.
- **Expected results:** No unconfirmed transition is recorded complete. The original intent and resource identity survive; a retry reads the prior outcome before repeating a write. Exactly one intended effect is completed and verified before internal advancement.
- **Evidence:** External resource reads, request/effect counts, persisted pending/completed transitions before and after restart, next-step start times.
- **Verification level:** Unit and integration; realistic counterpart in VER-TST-001-02.

#### VER-WF-001-03 — Late acceptance after a negative read

- **Coverage:** AC1, AC2, AC3, AC4, AC5; non-idempotent mutation uncertainty.
- **Preconditions:** F; a durable operation intent and correlation identity; independently observable in-flight Trello comment, GitHub review reply, and PR-creation variants; controllable request and read ordering.
- **Steps:** Dispatch an external write and time out before its acceptance is known. Return an initial negative read while the original request is still in flight, then accept the original request after the read. Restart during uncertainty and repeat reconciliation with controlled delays. Include a provider-idempotent variant and a non-discoverable write for which an operator must be notified.
- **Expected results:** A negative read does not authorize blindly resending an ambiguous non-idempotent operation. Where supported, stable identity, provider idempotency, or later authoritative discovery yields the single intended effect without duplicates. Otherwise the operation remains visibly pending with project ownership preserved and operator attention requested; no false completion or unconditional exactly-once claim is made. Other projects continue independently.
- **Evidence:** Persisted operation intent and identity, ordered request/read/acceptance ledger, resource identities and effect counts, timed rechecks, ownership state, restart and alert records.
- **Verification level:** Unit and integration; realistic provider behavior checked only where a controlled test environment can establish late acceptance.

#### VER-WF-001-02 — Enforce allowed transitions, not just successful writes

- **Coverage:** AC1, AC2, AC3; also the authoritative requirement that workflow states have explicitly allowed transitions.
- **Preconditions:** F; an agreed state/allowed-transition inventory derived from the sources, including pending external synchronization, active PR, waiting, and terminal outcomes.
- **Steps:** Exercise each allowed transition with verified and unverified external outcomes. Present incompatible events, such as PR approval treated as completion, outage treated as deletion, or an unexpected manual terminal-looking move. Retry/restart while such an event is pending.
- **Expected results:** Only an allowed transition with sufficient verified evidence advances workflow state. Incompatible or uncertain events preserve enough state for reconciliation rather than fabricate a terminal outcome or release ownership. Recovery reconciles before any later advancement; actual manual moves follow VER-CTX-004-01.
- **Evidence:** State/event/transition matrix, independent external reads, persisted before/after state, pending reconciliation and ownership timeline.
- **Verification level:** Unit and integration.

### REQ-WF-002 — Bounded internal progress and recovery

**Requirement ID:** REQ-WF-002

#### VER-WF-002-01 — Exhaust unrecoverable internal paths safely

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; a declared inventory of active operation types and allowed completion/recovery/failure transitions; pending next card.
- **Steps:** For each operation, exercise success, recoverable error, and unrecoverable internal error. Disable periodic monitoring for normal paths. Exhaust recovery; make Trello unavailable during failure finalization, then restore it.
- **Expected results:** Explicit paths progress without a watchdog. Internal retries stop at their bound. Genuine inability to continue produces an explanatory `Failed` outcome with retained work, but project ownership is released only after the terminal move is verified. Advisory failures instead follow publication scenarios.
- **Evidence:** Operation/transition inventory with results, attempt counts, work hashes, Trello reads/comments, ownership and next-task timeline.
- **Verification level:** Unit and integration.

#### VER-WF-002-02 — Recover abandoned intermediate work

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; separate fixtures with stale lock, abandoned session, orphan process, or inconsistent active execution record.
- **Steps:** Start/restart monitoring; observe detection and bounded reconciliation. Include a still-live owner and an unverifiable owner as negative controls.
- **Expected results:** Recoverable work resumes automatically; safely established unrecoverable internal work reaches verified `Failed`. Live or ambiguous ownership is not stolen. No card is silently abandoned in `Working`; unresolved external uncertainty remains explicit and rechecked.
- **Evidence:** Process/ownership observations, recovery decisions, preserved records, card states, recheck intervals and failure synchronization.
- **Verification level:** Integration.

### REQ-WF-003 — Distinguish waiting from stalled execution

**Requirement ID:** REQ-WF-003

#### VER-WF-003-01 — Human and dependency waits

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; A has an open normal or draft PR in `Human Review`; B can execute; global AI capacity is one.
- **Steps:** Observe B using capacity while A waits. Separately interrupt an active operation with a service outage beyond immediate retries; wait several recheck windows, restore service, and verify state before resumption.
- **Expected results:** Human review keeps A active without using an AI slot. Outage waiting preserves state with paced rechecks, no assumed failure or busy loop. Verified recovery resumes the same task; A never claims its next card during either wait.
- **Evidence:** Slot/operation timeline, service ledger, persisted waiting reason, task/PR identities, counts and preserved work.
- **Verification level:** Unit and integration.

## Pull request delivery (REQ-PR)

### REQ-PR-001 — Publish despite negative quality assessments

**Requirement ID:** REQ-PR-001

#### VER-PR-001-01 — Deliver meaningful work through adverse advisory outcomes

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; primary implementation completes meaningful edits; Git publication is safe.
- **Steps:** Independently inject rejected planning feedback, failing validation, failing coverage, negative implementation review, exhausted remediation, unavailable checks, and an advisory crash; also combine them. Permit the agent to disregard advice and finish.
- **Expected results:** Each run publishes meaningful changes without quality approval. Known significant problems yield a draft PR; description/diagnostics accurately identify failed, skipped, uncertain, and unresolved outcomes. No fabricated pass, quality-only `Failed`, or repeated unchanged-code cycle occurs.
- **Evidence:** Actual remote diff and PR draft state, command exits, review artifacts, correction counts, PR body, Trello outcome.
- **Verification level:** Integration and end-to-end (simulated services); realistic adverse-quality path in VER-TST-001-02.

### REQ-PR-002 — Bound advisory remediation

**Requirement ID:** REQ-PR-002

#### VER-PR-002-01 — Early finish, no-op, and limit exhaustion

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F; meaningful completed implementation; reviewer continues to reject; maximum corrections greater than one.
- **Steps:** Run variants where the agent stops early, disregards all advice and makes no changes, or changes code on each attempt until exhaustion. Poll again after cycle completion.
- **Expected results:** Maximums do not mandate iterations. Early finish is accepted; a no-change attempt stops that cycle without another review of unchanged code. Exhaustion proceeds to safe draft delivery, never `Failed` for dissatisfaction; no unchanged cycle restarts on later polls.
- **Evidence:** Before/after diff hashes, agent/reviewer invocation counts, configured bound, PR identity/state and later polling trace.
- **Verification level:** Unit and integration.

### REQ-PR-003 — Distinguish genuine implementation failure

**Requirement ID:** REQ-PR-003

#### VER-PR-003-01 — Primary crash recovery versus unrecoverable execution

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; before PR publication, primary session has partial code changes; existing operation retry configuration recorded.
- **Steps:** Kill the primary process unexpectedly. Run one variant with successful session restoration and one with confirmed unrecoverable session/context after bounded recovery. Compare with ordinary failing tests and a temporary OpenCode outage.
- **Expected results:** Execution evidence distinguishes the crash. Recovery uses the existing operation retry policy. Restored primary work continues; genuinely unrecoverable primary work reaches verified `Failed` with partial changes and diagnostics preserved and no automatic PR. Quality failures publish; a temporary outage waits safely rather than being mislabeled unrecoverable.
- **Evidence:** Exit/signal/session evidence, recovery counts and configuration, Git hashes, card/comment, PR count, waiting versus terminal records.
- **Verification level:** Unit and integration.

#### VER-PR-003-02 — Advisory crash permits delivery

- **Coverage:** AC1, AC5.
- **Preconditions:** F; completed meaningful implementation; planning/review/quality process separately identifiable.
- **Steps:** Crash each advisory process; exhaust its safe recovery and continue.
- **Expected results:** Crash is attributed to the advisory operation, recorded and skipped after bounded recovery. Primary execution is not classified failed; meaningful work reaches a PR with accurate unresolved status.
- **Evidence:** Process identities/exits, bounded attempts, stage records and PR diff/body/draft status.
- **Verification level:** Integration.

#### VER-PR-003-03 — Unrecoverable correction execution after PR publication

- **Coverage:** AC1, AC2, AC4; also REQ-REC-002 AC5 and REQ-SCH-001 AC2, AC3.
- **Preconditions:** F; a published open PR in `Human Review`, a requested-change operation in `Working`, an identifiable primary session, another eligible card, and independently observable GitHub/Trello state.
- **Steps:** Crash the primary correction process and exhaust bounded safe session recovery. Test both an ordinary recoverable outage and confirmed unrecoverable session/context, with local unshipped changes. Poll repeatedly and restart; then independently merge or close the PR.
- **Expected results:** The failed correction operation is recorded as an explicit recoverable operational blockage with preserved PR identity, local changes, diagnostics, and project ownership. The card does not become `Failed` while the PR is open; no replacement PR or new project task is created, and no uncontrolled correction loop occurs. A verified human merge or closure subsequently produces its normal terminal Trello outcome and releases ownership after reconciliation.
- **Evidence:** Session and process failure records, bounded recovery counts, PR/card states, worktree hashes, preserved ownership, request ledger, and human terminal-event reconciliation.
- **Verification level:** Integration and end-to-end (simulated services); realistic PR outcome in VER-TST-001-02.

### REQ-PR-004 — Publish normal or draft PRs accurately

**Requirement ID:** REQ-PR-004

#### VER-PR-004-01 — Publication readiness and notification matrix

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F; optional email enabled; completed meaningful work; quality variants all passing, failing tests/validation, negative review, and exhausted corrections.
- **Steps:** Execute each variant through publication. Delay verification of PR creation; then allow readback and the Trello transition. Inspect delivered email.
- **Expected results:** Demonstrably passing configured checks and no known material unresolved issues permit a normal PR; unresolved significant problems produce a draft with clear disclosure and no readiness claim. AI reviewer approval is not required. Both reach verified `Human Review` only after verified PR publication. Notification links the actual PR and identifies draft status/outstanding issues when relevant.
- **Evidence:** Remote commit/diff, PR metadata/body, ordered read/write ledger, card list and captured email.
- **Verification level:** Integration; realistic publication/email counterpart in VER-TST-001-02.

### REQ-PR-005 — Idempotent PR publication and Trello synchronization

**Requirement ID:** REQ-PR-005

#### VER-PR-005-01 — PR exists while Trello synchronization fails

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F; publishable branch; another ready card queued; a PR-creation request may remain in flight after an initial negative read.
- **Steps:** Allow PR creation, fail or lose acknowledgment of the Trello move/comment, and restart at each mutation boundary. Include an accepted-but-unacknowledged PR creation that appears only after an initial negative lookup; inspect whether a second creation request is suppressed. Restore service; let reconciliation finish and poll repeatedly.
- **Expected results:** The original PR identity is retained or safely rediscovered; one PR, one initial commit, and no duplicate completed comments/transitions result. Next task stays blocked throughout the unresolved state and while the reconciled PR remains open. No work is discarded.
- **Evidence:** PR/commit/comment identities and counts, Trello history, persisted pending action and task ownership, remote diff and next-task absence.
- **Verification level:** Integration and end-to-end (simulated services).

### REQ-PR-006 — Preserve publication work during GitHub outages

**Requirement ID:** REQ-PR-006

#### VER-PR-006-01 — Prolonged outage before or during publication

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F; completed meaningful implementation; attention email configured.
- **Steps:** Make GitHub unavailable before creation, and separately after accepting creation but before responding. Exhaust immediate retries, restart during the wait, observe multiple intervals, then restore service.
- **Expected results:** Branch, worktree, changes, and publication intent persist. Controlled rechecks reconcile uncertain prior creation before retrying. Outage alone never yields `Failed`; attention is visible without repeated alerts. Recovery delivers exactly one PR for the attempt.
- **Evidence:** Artifact hashes, request timings/counts, persisted publication state, notifications, PR query and identity, card/ownership timeline.
- **Verification level:** Integration and end-to-end (simulated services).

### REQ-PR-007 — Accurate, maintained PR descriptions

**Requirement ID:** REQ-PR-007

#### VER-PR-007-01 — Description follows actual implementation and activity

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; existing PR with human-authored underlying description content and known quality results.
- **Steps:** Inspect initial generated description; separately perform human correction, CI repair, and safe branch maintenance. Capture the body before, during each activity change, and after completion or unresolved finish.
- **Expected results:** Purpose, significant actual changes, observed tests/validation, outstanding issues, and Trello link are present and current. A prominent top status tracks current activity without erasing underlying content, then disappears when work finishes. Descriptions never invent successful checks.
- **Evidence:** Body snapshots with timestamps, remote diffs, check executions/results, task URL and activity timeline.
- **Verification level:** Integration; realistic body-update counterpart in VER-TST-001-02.

### REQ-PR-008 — Human control of PR outcome

**Requirement ID:** REQ-PR-008

#### VER-PR-008-01 — Open, approved, merged, and closed PRs

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; separate normal and draft open PR runs; next card ready.
- **Steps:** Poll with passing checks and approval; then, in independent runs, have a human merge or close without merge. Include delayed outcome reads.
- **Expected results:** No automatic merge is attempted. Open PRs retain active ownership and block the next card; approval alone changes neither rule. Confirmed human merge leads to verified `Done`; confirmed unmerged closure leads to verified `Backlog`, never an assumed outcome.
- **Evidence:** Actor-attributed GitHub mutation ledger, PR state/merged flag, Trello reads and next-task start times.
- **Verification level:** Integration; realistic human outcomes in VER-TST-001-02.

#### VER-PR-008-02 — Human terminal event during active automation

- **Coverage:** AC2, AC3, AC4, AC5; also REQ-HR-006 AC5–AC6.
- **Preconditions:** F; existing published PR, active human-remediation/CI-repair/maintenance operation, pending branch changes and next eligible card; GitHub merge/closure and push barriers independently controllable.
- **Steps:** Observe authoritative PR-state reads at publication boundaries. Merge and close the PR in separate runs while the agent edits, just before push, and after a push is dispatched but before acknowledgement. Include GitHub auto-deletion of the task branch, stale operation completion after terminal reconciliation, and restart during an in-flight write.
- **Expected results:** Verified merge/closure supersedes automation; no new mutation is scheduled or stale completion restores `Human Review`. Work is safely interrupted where possible, unshipped changes and diagnostics preserved, and dispatched writes reconciled. No branch is recreated to publish to a closed PR. Confirmed merge yields verified `Done`, confirmed unmerged closure verified `Backlog`; next task starts only after reconciliation. If a human action races an authoritative PR read, later write rejection/acceptance is reconciled rather than assumed safe.
- **Evidence:** Timestamped PR state and merge metadata, mutation/push ledger, process termination and local work hashes, queued/cancelled operations, Trello history and next claim timestamps.
- **Verification level:** Integration and end-to-end (simulated services); realistic PR terminal race as feasible with disposable GitHub resources.

## Trello task lifecycle (REQ-TR)

### REQ-TR-001 — Merged PR completion

**Requirement ID:** REQ-TR-001

#### VER-TR-001-01 — Verify merge and terminal synchronization

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; open PR and queued next card.
- **Steps:** Human merges PR; delay merge readback and then the Trello `Done` acknowledgment. Restart at each boundary; restore reads and repeat reconciliation.
- **Expected results:** Merge is confirmed before completion; `Done` is verified before another task starts. Replays neither duplicate completed effects nor reverse the outcome. Missing/unavailable PR reads are not interpreted as a merge.
- **Evidence:** PR merged metadata, ordered service calls, card history, completion records and next claim timestamp.
- **Verification level:** Integration and end-to-end (simulated services).

### REQ-TR-002 — Closed, unmerged PR outcome

**Requirement ID:** REQ-TR-002

#### VER-TR-002-01 — Closure and deliberate requeue

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; open PR with preserved remote changes and another eligible card.
- **Steps:** Human closes without merge; interrupt/retry outcome synchronization. Confirm `Backlog`, allow next selection, then explicitly requeue the closed task after the project is available.
- **Expected results:** Closed/unmerged metadata is verified. Exactly one concise closure comment explains the outcome and links the PR; card goes to `Backlog`, not `Failed`. Next work waits for confirmed transition; deliberate requeue is supported with a fresh attempt.
- **Evidence:** Closed/merged flags, card list/comment counts, task-attempt identities and selection timeline.
- **Verification level:** Integration; realistic closure in VER-TST-001-02.

### REQ-TR-003 — Genuine failure outcome and deliberate retry

**Requirement ID:** REQ-TR-003

#### VER-TR-003-01 — Failure remains terminal until human retry

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; unrecoverable primary/internal failure with partial changes; failure email enabled and disabled variants.
- **Steps:** Exhaust safe recovery, verify `Failed`, and poll repeatedly. Change the card and default branch, then explicitly move the card to `Ready for Agent`.
- **Expected results:** Failure explanation is posted and configured notification delivered without leaking secrets. No automatic retry occurs while in `Failed`. Explicit requeue creates a fresh clean attempt from current default branch, preserving old changes/diagnostics without incorporating them.
- **Evidence:** Card/comments/email, poll and attempt counts, old/new worktree diffs and bases, retained logs.
- **Verification level:** Integration and end-to-end (simulated services).

### REQ-TR-004 — Eligible task ordering

**Requirement ID:** REQ-TR-004

#### VER-TR-004-01 — Order, task types, and start-date boundaries

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; ordered mixed-type ready cards; future-dated first card and eligible lower cards; cards in other lists.
- **Steps:** Run each supported type as the first eligible card. Advance the clock from just before to at/after a future start date; complete preceding tasks before further selection. Reorder ready cards between claims.
- **Expected results:** Only `Ready for Agent` cards are claimed. First eligible card wins irrespective of type; ineligible/future cards do not block lower eligible cards. Future cards become selectable when their start date is reached, respecting current order.
- **Evidence:** Board order/date snapshots, clock values and task claim ledger with types.
- **Verification level:** Unit and integration.

## Task refinement (REQ-REF)

### REQ-REF-001 — Repository-grounded, read-only analysis

**Requirement ID:** REQ-REF-001

#### VER-REF-001-01 — Refine against current repository evidence

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; repository/attachments contain distinctive facts that contradict a plausible stale assumption; setup already complete.
- **Steps:** Request refinement requiring source, test, configuration, documentation, and attachment inspection. Compare factual claims against fixtures; snapshot all repository content before and after agent execution, including untracked files and refs.
- **Expected results:** Agent can access all relevant evidence; resulting task uses current verified facts without unsupported repository claims. Refinement itself changes no repository content. Keep setup's separately recorded effects distinct (A4).
- **Evidence:** Accessible context manifest, file-read evidence where available, factual rubric, repository hashes/status/refs and refined card.
- **Verification level:** Integration and end-to-end (realistic, required for actual agent grounding).

### REQ-REF-002 — Actionable task classification and templates

**Requirement ID:** REQ-REF-002

#### VER-REF-002-01 — Classify and structure representative tasks

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; tasks clearly representing Feature, Improvement, and Bug; approved reference templates and human rubric (A2).
- **Steps:** Refine each task and one variant with irrelevant template sections. Compare results with classification, task intent, template structure, and rubric.
- **Expected results:** Classification is one of the three agreed types and appropriate to the fixture. Distinct default structures are used; irrelevant sections may be adapted/omitted. Work is actionable and technically grounded without a detailed implementation plan.
- **Evidence:** Template inputs/versions, full refined outputs and independent rubric judgments with supporting repository facts.
- **Verification level:** Unit for result validation; integration and end-to-end (realistic) for agent output quality.

### REQ-REF-003 — Preserve task intent and scope

**Requirement ID:** REQ-REF-003

#### VER-REF-003-01 — Necessary dependencies versus unrelated expansion

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F; one narrowly scoped task with a necessary dependency and tempting unrelated refactor; one oversized task.
- **Steps:** Refine both; compare original objective with resulting title/description. Inspect all board card creations and repository writes.
- **Expected results:** Original intent is retained. Only strictly necessary work enters scope; larger dependencies/opportunities are identified as such. Oversized task is still refined and may recommend splitting, but no cards are automatically created or split and no unrelated refactor is included.
- **Evidence:** Original/refined text, necessity rubric with repository evidence, card counts/create ledger and repository hashes.
- **Verification level:** Integration and end-to-end (realistic, human assessment required for scope).

### REQ-REF-004 — Verified completion and failure recovery

**Requirement ID:** REQ-REF-004

#### VER-REF-004-01 — Reject invalid complete results before mutation

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; original card fields snapshotted; malformed, incomplete, and invalid-classification refinement outputs.
- **Steps:** Supply each invalid result; run correction-success and correction-exhaustion variants. Observe card writes throughout, not just after completion.
- **Expected results:** Complete result validation precedes any field update. Corrections are bounded. If correction cannot succeed, original fields remain intact, card reaches verified `Failed` with explanation, and refinement is not reported complete.
- **Evidence:** Result validation/attempt records, ordered field-write ledger, original/current card fields, failure comment and completion-event absence.
- **Verification level:** Unit and integration.

#### VER-REF-004-02 — Interrupt applying validated refinement

- **Coverage:** AC1, AC3, AC4, AC5, AC6.
- **Preconditions:** F; valid new title, description, classification; partial-write and lost-acknowledgment fault support; independently observable card change history and a barrier between the final field read and write acceptance.
- **Steps:** Fail each update boundary; restart and reconcile. Include recoverable writes and a permanently unsuccessful update after bounded recovery. Inject a human edit to an untouched field, an already-updated field, and a field whose earlier update acknowledgment was lost before attempting completion or rollback. Separately accept a human edit after the final comparison read but before the orchestrator's write is accepted, during initial application and recovery completion/rollback. Read back fields and available history after the write; restart during conflict reconciliation. Include unavailable history that prevents safe attribution, or unattributable edits, as uncertainty variants.
- **Expected results:** Original fields and the intended complete update are persisted before the first write. No partial update is represented as success. Without conflicting edits, recoverable completion verifies the full result; failed completion verifies restored original fields before terminal failure. Detected human changes are not knowingly overwritten. A read/write race may temporarily overwrite a human value; post-write checks detect the fixture's recorded concurrent edit, preserve recoverable human content and evidence, and pause further writes for explicit reconciliation rather than claim success or blindly restore the original snapshot. Uncertain writes or unattributable changes retain pending reconciliation and project ownership with operator attention when needed, without false success, rollback, or failure claims. No atomic compare-and-write or universal overwrite-prevention guarantee is inferred.
- **Evidence:** Ordered comparison reads, human edits and accepted writes; card field snapshots and available action history; preserved original, intended and recoverable human values; pending/restoration records, restart state and completion/failure events.
- **Verification level:** Integration; realistic read/write race detection and reconciliation must also be checked in the isolated live environment without assuming atomic conditional updates.

### REQ-REF-005 — Successful refinement outcome

**Requirement ID:** REQ-REF-005

#### VER-REF-005-01 — Complete refinement once and release after verification

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F; valid refinement; measured duration and unavailable-duration variants; next task ready.
- **Steps:** Apply result, interrupt between field update, comment, and `Backlog` synchronization, then restart. Delay readback before allowing final verification.
- **Expected results:** Full validated fields are applied. Verified `Backlog` releases the project. One concise completion comment identifies selected type and duration when available, without repeating the description or inventing a duration. No premature next claim or duplicated comment occurs.
- **Evidence:** Card readback, comment content/count, measured times, pending action state and next-task timeline.
- **Verification level:** Integration and end-to-end (simulated services); realistic refinement path in VER-TST-001-02.

## Implementation execution (REQ-IMP)

### REQ-IMP-001 — Isolated task-specific Git worktree

**Requirement ID:** REQ-IMP-001

#### VER-IMP-001-01 — Task-relevant changes stay isolated

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; dirty original checkout and unrelated worktree; task needs source, tests, configuration, and documentation edits.
- **Steps:** Implement the task; inspect command working directories, worktree/branch ownership, file hashes, and all diffs. Include an attempted write outside the task boundary as a negative variant.
- **Expected results:** Relevant changes are possible within the owned branch/worktree. Original checkout files/index/HEAD and unrelated state remain unchanged, with shared task metadata accounted for as in F; no unrelated changes enter the task. Unsafe boundary operations do not silently succeed.
- **Evidence:** Worktree inventory/ownership, process directories, before/after original/unrelated hashes and task diff with scope assessment.
- **Verification level:** Integration; realistic agent scope assessment in VER-TST-001-02.

### REQ-IMP-002 — Current task context and attachments

**Requirement ID:** REQ-IMP-002

#### VER-IMP-002-01 — Refresh task evidence on start and resume

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; image/document/log fixtures; task description and repository facts change before resume.
- **Steps:** Start implementation requiring those facts; interrupt, update task/attachments, then resume. Separately fail attachment download/access.
- **Expected results:** Current task/repository and supported attachments are accessible at start/resume; stale facts are not the sole context. Downloads are outside worktrees and absent from commits. Access failures are explicitly reported rather than silently treated as an attachment-free task.
- **Evidence:** Context/attachment manifest and hashes, actual fact-based edits, download paths, Git diff, failure diagnostics and session inputs.
- **Verification level:** Integration and end-to-end (realistic for service download and agent use).

### REQ-IMP-003 — Advisory planning and independent review

**Requirement ID:** REQ-IMP-003

#### VER-IMP-003-01 — Plan before code without an approval gate

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F; independent reviewer; plan and attachment facts observable; negative and unavailable planning/review variants.
- **Steps:** Trace task/repository/attachment analysis and plan preparation before code edits. Have reviewer evaluate correctness/completeness/alignment; let implementer adopt, adapt, or disregard feedback. Exhaust failed advisory attempts.
- **Expected results:** Planning is attempted before modifying code, with independent feedback available when the reviewer operates. Negative/rejected/unavailable planning or review never becomes required approval; bounded failure still allows implementation and meaningful PR delivery.
- **Evidence:** Ordered context/plan/review/edit events, distinct session identities, feedback and chosen edits, bounded counts and PR diff.
- **Verification level:** Integration; end-to-end (realistic) for actual plan/reviewer behavior.

### REQ-IMP-004 — Primary OpenCode session continuity

**Requirement ID:** REQ-IMP-004

#### VER-IMP-004-01 — Session across the full correction lifecycle

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; primary session established; distinctive prior decisions and feedback.
- **Steps:** Perform local validation repair, CI repair, human changes, and later remediation. Inspect session routing and supplied/retrievable context for each activity and independent review.
- **Expected results:** Available safe primary session is reused across all implementation corrections with relevant earlier context. Independent plan and implementation reviewers have separate sessions; no cross-task/session mixup occurs.
- **Evidence:** Session identifiers and request history, context manifest, prior/current diffs, distinct reviewer references.
- **Verification level:** Integration and end-to-end (realistic for real session continuity).

#### VER-IMP-004-02 — Restore or reconstruct after session interruption

- **Coverage:** AC2, AC4.
- **Preconditions:** F; interrupted session; separate reconnectable, confirmed-lost/reconstructable, and uncertain-context fixtures.
- **Steps:** Restart and inspect original-session connection attempts; permit replacement only in the confirmed-lost fixture with reconstructed context.
- **Expected results:** Restore is attempted first. Safe replacement receives task, repository, attachments, available plan, prior changes/history and feedback; no context-free reset. Uncertain state is preserved and reported instead of guessed.
- **Evidence:** Connection/replacement order, session IDs, reconstruction inventory, preserved work and recovery outcome.
- **Verification level:** Integration; realistic session-loss path requires isolated OpenCode execution.

### REQ-IMP-005 — No artificial changes for PR creation

**Requirement ID:** REQ-IMP-005

#### VER-IMP-005-01 — Already satisfied and no meaningful output

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; one task already satisfied by repository evidence and one producing no meaningful changes after appropriate attempts (A2).
- **Steps:** Execute each through bounded analysis/implementation attempts; inspect all file and commit changes. Then explicitly requeue with a revised actionable task.
- **Expected results:** No manufactured edit, empty/artificial commit, or meaningless PR is created. Card reaches verified `Failed`, not `Done`, with explanation and retained diagnostics. Deliberate retry remains possible in a fresh clean attempt.
- **Evidence:** Repository evidence of satisfaction, diff/object/ref history, PR count, attempt trace, card/comments and new-attempt base.
- **Verification level:** Integration and end-to-end (realistic for semantic meaningfulness).

## Validation and AI review (REQ-VAL)

### REQ-VAL-001 — Orchestrator-executed quality commands

**Requirement ID:** REQ-VAL-001

#### VER-VAL-001-01 — Independent optional commands and honest results

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F; two projects; validation/coverage configuration matrix: neither, each alone, both; executable fixtures with success, nonzero exit, and uncertain interruption variants.
- **Steps:** Have agent claim all checks passed regardless of actual result. Let orchestrator run configured commands; inspect process invocations and reports.
- **Expected results:** Each configured command is actually run by the orchestrator for its own project. Missing commands are skipped, never passed; observed success/failure/uncertainty overrides agent claims. No command configured is also a valid path to implementation/PR delivery.
- **Evidence:** Independent invocation markers/exits, effective configuration, working directories, stage records and PR reported outcomes.
- **Verification level:** Unit and integration.

### REQ-VAL-002 — Independent review remains advisory

**Requirement ID:** REQ-VAL-002

#### VER-VAL-002-01 — Negative or unusable review is not a veto

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F; meaningful completed edits; reviewer returns useful negative, malformed, missing, or unavailable output.
- **Steps:** Run every output variant, allowing the implementer to adopt, adapt, or disregard all advice; observe publication.
- **Expected results:** Available findings are recommendations supplied to the implementer. Unusable output is recorded accurately. No reviewer approval is required and no review-only implementation failure is declared; bounded processing continues to publication.
- **Evidence:** Review artifacts/parser outcomes, feedback delivered to implementer, correction decisions/counts and actual PR diff/state.
- **Verification level:** Unit and integration.

### REQ-VAL-003 — Separate bounded improvement attempts

**Requirement ID:** REQ-VAL-003

#### VER-VAL-003-01 — Independent counters, early exit, and no-op stop

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F; unequal validation and AI-review remediation maxima; persistently failing checks/review.
- **Steps:** Exercise each limit independently and together; run early-finish and no-change variants. Restart just before/at exhaustion and poll after publication.
- **Expected results:** Each policy respects its own maximum without resetting on restart or multiplying into an endless cross-cycle loop. Early finish/no-op ends the relevant cycle; unchanged code is not reviewed repeatedly. Remaining meaningful work publishes as draft rather than quality-only `Failed`.
- **Evidence:** Per-policy attempts before/after restart, diff hashes, reviewer/command counts, PR and cycle-end timeline.
- **Verification level:** Unit and integration.

### REQ-VAL-004 — Advisory process failures do not block delivery

**Requirement ID:** REQ-VAL-004

#### VER-VAL-004-01 — Exit, crash, and timeout classification

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F; complete meaningful implementation; quality fixture can return nonzero, receive a fatal signal, or hang with a child process.
- **Steps:** Run each variant, including an unavailable independent-review dependency after meaningful implementation has completed. Exhaust bounded advisory attempts and observe publication; contrast with unavailable OpenCode during unfinished primary work.
- **Expected results:** Normal nonzero exit is a quality failure, not primary crash. Unavailable/crashed/timed-out advisory steps are separately recorded and skipped after bounded attempts; safe PR delivery proceeds with accurate unresolved outcome. Essential unavailable primary execution instead preserves monitored waiting.
- **Evidence:** Exit/signal/liveness records, process tree, attempt counts, stage classification, Git hashes and PR.
- **Verification level:** Unit and integration.

### REQ-VAL-005 — Accurate disclosure and PR readiness

**Requirement ID:** REQ-VAL-005

#### VER-VAL-005-01 — Quality reporting through draft and ready states

- **Coverage:** AC1, AC2, AC3, AC4, AC5.
- **Preconditions:** F; all-pass, unresolved-problem, skipped/unconfigured, and uncertain check variants; draft with subsequently addressed issues.
- **Steps:** Publish each variant; for the draft, fix documented outstanding issues with evidence and update status without requesting AI approval. Include remaining significant problems as a negative readiness control.
- **Expected results:** Demonstrably passing configured checks with no known material unresolved issue permit a normal PR. Failed, skipped, or uncertain checks and material outstanding findings cause draft publication with accurate disclosure. Disregarded advisory suggestions alone cannot veto PR publication or force draft status; documented material concerns still require draft. Resolving concerns with evidence permits ready status without reviewer approval.
- **Evidence:** Observed quality artifacts, PR draft/body history, outstanding-issue disposition and readiness mutation ledger.
- **Verification level:** Integration; realistic GitHub draft/ready behavior in VER-TST-001-02.

## Human review and requested changes (REQ-HR)

### REQ-HR-001 — Collect actionable GitHub feedback

**Requirement ID:** REQ-HR-001

#### VER-HR-001-01 — Refresh every feedback source and revision

- **Coverage:** AC1, AC2, AC3, AC4, AC5.
- **Preconditions:** F; PR with actionable review summary, inline comment, general comment without file context, and previously handled requests.
- **Steps:** Edit one comment substantively and another cosmetically, delete one, supersede another, and add actionable standalone human feedback. Add bot status, orchestrator replies, and non-actionable discussion. Run remediation and subsequent unchanged polls.
- **Expected results:** Current actionable human requests are collected with file/line context when present. Standalone requests remain eligible, while bot/orchestrator self-replies, status, and ordinary discussion do not trigger remediation. Substantive human edits are reevaluated; cosmetic edits and previously exhausted unchanged requests do not renew a cycle.
- **Evidence:** GitHub source IDs/revisions/content, collected context, disposition history and exact remediation invocation set.
- **Verification level:** Unit and integration; realistic feedback API behavior in VER-TST-001-02.

### REQ-HR-002 — Remediate on the existing PR

**Requirement ID:** REQ-HR-002

#### VER-HR-002-01 — Same-PR correction despite advisory failure

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F; PR in `Human Review`; human requests changes; adverse validation/reviewer variants.
- **Steps:** Submit changes-requested review without moving Trello manually; complete available edits while advisory steps fail/exhaust. Interrupt one update before acknowledgment and reconcile.
- **Expected results:** Verified transition to `Working` accompanies remediation. Corrections are additive commits on the existing branch/PR; no replacement PR. Bounded advisory outcomes do not veto publication. Card returns to verified `Human Review` with current unresolved information.
- **Evidence:** Original/current PR and branch IDs, remote diffs/commits, card transition history, correction limits and body/replies.
- **Verification level:** Integration and end-to-end (simulated services); realistic counterpart in VER-TST-001-02.

### REQ-HR-003 — Preserve feedback arriving during execution

**Requirement ID:** REQ-HR-003

#### VER-HR-003-01 — Queue concurrent arrivals without repeating old requests

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F; active blocked-at-barrier OpenCode correction; one previously attempted unresolved comment.
- **Steps:** Add new feedback during execution, poll, restart after recording the arrival, then release the operation. Add another request at cycle completion; later poll unchanged feedback repeatedly.
- **Expected results:** Arrivals are retained and queued without interrupting active work. A refresh after completion processes newly actionable feedback, including boundary arrivals. Branch-mutating operations never overlap. Previously attempted unchanged unresolved requests alone do not restart remediation.
- **Evidence:** Comment revision history, durable pending feedback, operation intervals, branch mutation ledger, processed IDs and invocation counts.
- **Verification level:** Unit and integration.

### REQ-HR-004 — Publish partial corrections honestly

**Requirement ID:** REQ-HR-004

#### VER-HR-004-01 — Partial fixes, accurate replies, human-owned threads

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F; three requests with independently demonstrable fixed, unresolved, and uncertain dispositions; negative independent verification.
- **Steps:** Produce a partial correction; let verification remain negative; publish and inspect replies and thread metadata. Restart/retry reply publication at uncertain-acknowledgment boundaries.
- **Expected results:** Available corrections reach the same PR without universal reviewer agreement. Replies cite adequate evidence for fixes and explicitly retain unresolved/uncertain dispositions. PR stays draft and returns to `Human Review`. No thread-resolution API action or duplicate reply occurs.
- **Evidence:** Remote diff and targeted observed behavior, PR body/draft state, reply contents/counts, thread resolution metadata and mutation ledger.
- **Verification level:** Integration; end-to-end (realistic) for reply and thread behavior.

### REQ-HR-005 — Unlimited human feedback rounds, bounded internal attempts

**Requirement ID:** REQ-HR-005

#### VER-HR-005-01 — New rounds remain possible after prior exhaustion

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F; open PR; small internal attempt maxima; repeated distinct human revisions.
- **Steps:** Complete more human rounds than any configured internal correction limit, using new or edited requests each time; exhaust internal attempts in some rounds. Finally approve the PR without merging and continue polling.
- **Expected results:** Every new actionable round remains eligible with bounded per-round attempts; no lifetime human-round cap is applied. Negative AI results do not prevent round completion. Approval neither merges nor completes the task; ownership and monitoring continue.
- **Evidence:** Round/request revision ledger, per-round counts, configured policies, approval/PR state, no merge/next-task action. Pair runtime observations with a deterministic eligibility check across large round counts.
- **Verification level:** Unit and integration.

### REQ-HR-006 — Coordinate active-PR work

**Requirement ID:** REQ-HR-006

Shared scenario VER-PR-008-02 verifies AC5 and AC6 through terminal-event checks and in-flight write races.

#### VER-HR-006-01 — Queue priorities and prerequisites

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F; active operation held at a barrier; pending human changes, CI repair, and routine maintenance; separate fixture where safe human work requires branch update first.
- **Steps:** Enqueue all operation types while held; release and inspect order. Repeat with prerequisite fixture and restart while queue is pending.
- **Expected results:** One project queue serializes mutations. Default next order is human changes, CI repair, then routine maintenance; a necessary safe prerequisite may precede dependent work with an observable reason. Restart/arrivals lose no feedback or CI operation and cause no overlap. The terminal-event and in-flight-write variants are exercised by VER-PR-008-02, not inferred from this queue-order run.
- **Evidence:** Queue inputs/order, prerequisite evidence, persisted pending operations and mutation intervals/diffs.
- **Verification level:** Unit and integration.

## GitHub CI (REQ-CI)

### REQ-CI-001 — Observe expected checks with bounded waiting

**Requirement ID:** REQ-CI-001

#### VER-CI-001-01 — Revision-scoped check results and bounded uncertainty

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; published PR; declared expected-check fixture (A5); checks succeeding, failing, absent, never starting, pending forever, and timing out.
- **Steps:** Run each variant after creation and after a new commit. Include stale success for the previous SHA; advance through the CI wait bound and inspect return to human review.
- **Expected results:** Results are associated with current revision, not stale checks. Missing/pending/timed-out checks remain uncertain, never passed. Waiting ends at the configured bound without withdrawing publication or leaving `Working` indefinitely; uncertainty is disclosed.
- **Evidence:** Expected-check definition, SHA/check IDs, poll timings, quality report, PR/card history and bounded waiting decision.
- **Verification level:** Unit and integration; end-to-end (realistic) for actual check discovery and status behavior.

### REQ-CI-002 — Bounded, advisory CI repair

**Requirement ID:** REQ-CI-002

#### VER-CI-002-01 — Fix, no-op, and exhaustion on the same PR

- **Coverage:** AC1, AC2, AC3, AC4, AC5, AC6.
- **Preconditions:** F; failed current-revision CI; distinct CI correction maximum from local validation/review limits; repair episode identities and initiating events tracked independently.
- **Steps:** Offer failure diagnostics; run successful fix, no-useful-change, and repeated-failure-to-limit variants. Push a chain of self-generated repair commits with failing CI on each SHA and verify the same budget is consumed. Restart at exhaustion, poll repeatedly, and perform routine target synchronization without renewing exhausted repairs. Separately introduce genuinely new human-requested changes, including an explicit request to retry the same exhausted failure, and an independently caused materially new CI failure. Verify each new episode's identity and initiating event; repeat the already-handled human request as a negative control.
- **Expected results:** Agent receives failed checks and diagnostics. Fixes use the same PR and checks are reevaluated. Self-generated commits, repeated failures, polling, restart, and routine branch synchronization do not reset an episode's budget. A genuinely new human-requested-change cycle may renew the budget, including for the previously exhausted failure; an independently caused materially new failure may also begin a new episode. Each episode has its own bounded allowance and a verified new trigger. Unchanged findings or an already-handled human request alone never automatically renew exhausted repairs. Unresolved CI is disclosed on a draft PR and never blocks PR delivery.
- **Evidence:** Delivered diagnostics, initiating human request revisions or independent external changes, episode identities and per-episode/policy counts, new commit/check SHAs, PR identity/body/draft flag and cycle timeline.
- **Verification level:** Unit and integration; realistic CI repair path in VER-TST-001-02.

## Automatic PR maintenance (REQ-MNT)

### REQ-MNT-001 — Detect outdated branches and merge conflicts

**Requirement ID:** REQ-MNT-001

#### VER-MNT-001-01 — Poll and coordinate maintenance of open PRs

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; open normal/draft PR; approved-open variant; active human/CI operation barrier.
- **Steps:** Advance target branch without conflict and separately with conflicting edits. Poll without Trello actions; release the active operation.
- **Expected results:** Needed branch update/conflict work is detected automatically, including approved-open PRs. Maintenance is queued and never concurrently mutates the task branch with human changes or CI repair.
- **Evidence:** Target/head SHAs, mergeability observations, queued activities, operation intervals and unchanged Trello input.
- **Verification level:** Integration and end-to-end (realistic for live mergeability detection).

### REQ-MNT-002 — Safely update the existing PR branch

**Requirement ID:** REQ-MNT-002

#### VER-MNT-002-01 — Safe update and refusal of unsafe publication

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F; target advanced; clean fast-forward-compatible fixture and published divergent branch fixture; dirty-worktree and unrelated remote-update variants.
- **Steps:** Synchronize a published divergent PR branch by merging the latest target into the task branch, with agent conflict resolution when needed. Inspect the remote commit graph and PR identity. Separately test pre-publication rebase, dirty-worktree preservation, and rejected pushes.
- **Expected results:** Published PR synchronization adds a merge commit when needed, preserving all published commit identities and the same PR. Conflicts can be resolved safely; no force-push, history rewrite, lost unrelated work, replacement PR, or uncontrolled loop occurs. Pre-publication rebase is allowed when safe.
- **Evidence:** Before/after commit objects and remote refs, push options/ledger, worktree hashes, conflict artifacts, bounded attempts and PR identity.
- **Verification level:** Integration and end-to-end (realistic), inspecting published commit ancestry and PR identity.

### REQ-MNT-003 — Reevaluate changes without introducing review gates

**Requirement ID:** REQ-MNT-003

#### VER-MNT-003-01 — Bounded post-maintenance quality evaluation

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; safe available branch update/conflict correction on an existing PR; advisory checks can fail or be unavailable.
- **Steps:** Run validation, independent review, and CI reevaluation after changes; exercise failure/no-op/exhaustion and safe-publication variants.
- **Expected results:** Current outcomes/remaining issues are reported on the same PR. Negative/unavailable advice cannot veto available safe corrections. Cycle completes or explicitly preserves a recoverable safety/external blocker; no endless remediation occurs.
- **Evidence:** Changed revision/diff, command/review/check results, PR body/draft state, attempt counts and cycle/wait state.
- **Verification level:** Integration; realistic reevaluation after merge-based synchronization of an existing published PR branch.

### REQ-MNT-004 — Maintain visible, temporary PR activity status

**Requirement ID:** REQ-MNT-004

#### VER-MNT-004-01 — Activity status across success, failure, and restart

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; existing PR with preserved description; rebase/conflict, CI, and human-change activities.
- **Steps:** Pause at each activity boundary, inspect body, progress to validation, and finish with success or unresolved findings. Restart mid-activity and reconcile the visible status.
- **Expected results:** Top status names current activity and changes as work progresses. Underlying content survives and reflects current implementation. Completed activity has no stale temporary status, including unresolved completion; an interrupted active activity is not falsely declared finished.
- **Evidence:** Timestamped PR body snapshots, activity and restart timeline, remote diffs and final body.
- **Verification level:** Integration; realistic API updates in VER-TST-001-02.

## Crash recovery and workflow resilience (REQ-REC)

### REQ-REC-001 — Resume from verified state after restart

**Requirement ID:** REQ-REC-001

#### VER-REC-001-01 — Restart across lifecycle boundaries

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F; A active at selection/setup/implementation/commit/push/PR/card/human-correction/terminal-cleanup boundaries; B healthy.
- **Steps:** For each boundary, crash application, perform planned shutdown, and restart the container in separate variants. Resume with external reads delayed and later restored.
- **Expected results:** Ownership, progress, worktrees, edits, and session references survive. Verified reconciliation precedes continuation; completed effects are not replayed into duplicate commits/PRs/comments/transitions. A's recovery issue does not block B.
- **Evidence:** Durable snapshots, Git objects/diffs, resource IDs/counts, session references, recovery reads and B's activity timeline.
- **Verification level:** Integration and end-to-end (simulated services); realistic restart path in VER-TST-001-02 and environment parity in VER-ENV-001-01.

### REQ-REC-002 — Recover primary AI session and context

**Requirement ID:** REQ-REC-002

Shared scenario VER-PR-003-03 verifies AC5 for an existing open PR; the pre-publication scenario below does not establish that behavior.

#### VER-REC-002-01 — Reconnect, replace safely, or fail primary execution

- **Coverage:** AC1, AC2, AC3, AC4, AC6.
- **Preconditions:** F; before PR publication, partial primary changes and known plan/history/feedback; original session reachable, confirmed lost, and uncertain variants; existing operation retry values recorded.
- **Steps:** Interrupt implementation; inspect reconnect-first behavior. Permit replacement only with confirmed loss and reconstructable context. Exhaust recovery with genuinely unrecoverable primary execution; compare negative-quality and temporary-outage controls.
- **Expected results:** Original session is tried first. Replacement receives all relevant available context and preserves work/progress. Genuine primary unrecoverability reaches verified `Failed` without automatically publishing interrupted changes. Existing retry policy applies, with no separate crash setting; quality dissatisfaction is not a crash, and outage alone is waiting.
- **Evidence:** Session/reconnect order, context inventory, policy/counters, execution evidence, Git hashes, PR absence/presence and card outcome.
- **Verification level:** Unit and integration; end-to-end (realistic) for OpenCode recovery/context behavior.

### REQ-REC-003 — Handle temporary external outages

**Requirement ID:** REQ-REC-003

#### VER-REC-003-01 — Dependency outage matrix

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F; independently controllable Trello, GitHub, OpenCode, and another enabled dependency; B remains healthy where dependency scope permits.
- **Steps:** For each dependency, inject timeout/unavailable reads and uncertain writes, exhaust immediate attempts, restart during waiting, observe delayed rechecks, then restore service. Separately block an independent advisory review after implementation is complete, and block OpenCode during unfinished primary execution.
- **Expected results:** Unavailability never proves deletion or prior write failure. Primary dependencies produce observable monitored waiting, but exhausted unavailable advisory review is skipped with accurate disclosure and does not block a safely publishable PR. Recovery verifies prior outcomes before repeat effects/resumption. Attention alerts are deduplicated and unaffected projects continue.
- **Evidence:** Request timing/effect ledger, durable pending/wait state, artifact hashes, notifications and independent project timeline.
- **Verification level:** Integration and end-to-end (simulated services).

### REQ-REC-004 — Resolve stale and inconsistent workflow ownership

**Requirement ID:** REQ-REC-004

#### VER-REC-004-01 — Normal paths versus last-resort monitoring

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F; operation path inventory; fixtures for abandoned process, stale lock, invalid record, and genuinely live/ambiguous owner.
- **Steps:** Verify normal success/error/recovery with monitoring withheld. Then enable monitoring for injected inconsistent idle work, before and after restart. Exhaust unrecoverable internal recovery; delay Trello terminal verification.
- **Expected results:** Normal progress has explicit paths. Monitoring detects unexpected stalls and reconciles safely. Confirmable internal failure reaches `Failed`, but release waits for verified Trello state. Unknown external/ownership state remains visible with controlled rechecks; no ownership theft, busy loop, or silent permanent lock occurs.
- **Evidence:** Transition coverage, process/lock facts, detection/retry times, records before/after, terminal readback and release timeline.
- **Verification level:** Unit and integration.

### REQ-REC-005 — Preserve state during graceful shutdown and upgrades

**Requirement ID:** REQ-REC-005

#### VER-REC-005-01 — Shutdown during active execution

- **Coverage:** AC1, AC4.
- **Preconditions:** F; active child process with descendant and uncommitted edits; additional ready cards.
- **Steps:** Send normal deployment termination signal during work and while a claim is pending; observe exit and restart.
- **Expected results:** New claims stop after shutdown begins. Active process tree is safely interrupted, state/work retained, and resources released only safely. Startup verifies ownership/external state before resuming, without duplicate execution.
- **Evidence:** Signal and claim timestamps, process-tree liveness, persisted state/work hashes, ownership records and restart operations.
- **Verification level:** Integration in local and container environments.

#### VER-REC-005-02 — Compatible, migratable, and unsupported persisted versions

- **Coverage:** AC2, AC3, AC4.
- **Preconditions:** F; representative prior-version active-state fixtures with ownership/sessions/progress; current compatible and migration-required versions; unsupported/corrupt migration variants; B unaffected.
- **Steps:** Upgrade/start each fixture; inject interruption/failure during migration; retry startup and compare original data.
- **Expected results:** Compatible or safely migrated state resumes after verification with ownership/session/progress intact. Unsupported/failed migration preserves original state and reports a useful blocker; no partial corruption or unsafe execution. Healthy projects proceed where safe.
- **Evidence:** Versioned fixture manifest, before/after state hashes/backups, migration outcome, session/work refs and project startup timeline.
- **Verification level:** Unit and integration; realistic upgrade run requires actual prior/current application artifacts, not invented state alone.

### REQ-REC-006 — Bound operation timeouts without a task-wide deadline

**Requirement ID:** REQ-REC-006

#### VER-REC-006-01 — Timeout kills operation tree and preserves progress

- **Coverage:** AC1, AC3, AC4.
- **Preconditions:** F; each long-running operation class can hang and spawn descendants; edits/logs already exist; recorded timeout/recovery values.
- **Steps:** Hang each operation; advance to its timeout; observe parent/descendant termination and bounded recovery. Include advisory and primary execution variants.
- **Expected results:** Affected process tree stops safely; changes/state/logs survive. Recovery ends in a defined resumed, waiting, or genuine-failure outcome based on evidence. Advisory timeout does not itself block safe meaningful PR delivery.
- **Evidence:** Process tree and liveness, elapsed time, attempt counts, preserved artifacts, classification and subsequent PR/card state.
- **Verification level:** Unit and integration.

#### VER-REC-006-02 — Long progress is not a stall

- **Coverage:** AC2, AC3.
- **Preconditions:** F; task spans many operations with meaningful progress; separate operation is genuinely stalled; agreed progress indicators (A5).
- **Steps:** Advance task age by hours/days while each operation remains within its timeout and progresses. Contrast with stalled-operation fixture.
- **Expected results:** No task-wide deadline or age-only failure occurs. Genuine stall is detected and safely recovered within bounded attempts, preserving work and producing an observable subsequent outcome.
- **Evidence:** Progress/time trace, operation deadlines, stall detection reason, recovery and continued task state.
- **Verification level:** Unit and integration.

## Git safety, cleanup, and retries (REQ-GIT)

### REQ-GIT-001 — Protect original checkout and unrelated work

**Requirement ID:** REQ-GIT-001

#### VER-GIT-001-01 — Safety across implementation, repair, and recovery

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; dirty original checkout, unrelated local worktree/branch, uncommitted task edits, and unrelated remote commits.
- **Steps:** Run implementation, human correction, CI, maintenance, recovery, and cleanup attempts. Inject remote advancement and unsafe push rejection; inspect every Git mutation.
- **Expected results:** Agent changes stay in its owned task worktree/branch. Original and unrelated work remain intact; no force-push, overwrite of unrelated remote changes, or automatic discard of uncommitted changes occurs even after failure/restart.
- **Evidence:** Before/after hashes/status/refs, remote history and rejected pushes, Git invocation options, worktree ownership and recovery artifacts.
- **Verification level:** Integration and end-to-end (realistic for remote protections).

### REQ-GIT-002 — Preserve understandable, additive commit history

**Requirement ID:** REQ-GIT-002

#### VER-GIT-002-01 — One initial commit, additive corrections

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; task needs multiple file edits; subsequent human, CI, and maintenance corrections; message-generation agent available.
- **Steps:** Implement and publish; interrupt initial commit acknowledgment and recover. Add each correction type; inspect objects and parent links after each. Human squash-merges in a separate terminal variant.
- **Expected results:** Initial implementation is one clean meaningful commit with generated descriptive message. Later corrections and published-branch synchronization add commits without rewriting earlier published commits. Retry does not duplicate a commit. Human squash at merge is permitted.
- **Evidence:** Commit graph, object IDs/messages/diffs, generation input/output, commit/push ledger and merge actor.
- **Verification level:** Integration; realistic history verification with actual remote Git.

### REQ-GIT-003 — Verify ownership before cleanup

**Requirement ID:** REQ-GIT-003

#### VER-GIT-003-01 — Cleanup safety matrix

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; owned-clean, owned-dirty, unknown, similarly named unowned, and ownership-ambiguous branches/worktrees; unpreserved local-only commits.
- **Steps:** Trigger cleanup for each, including restart with incomplete ownership evidence and unavailable remote preservation checks.
- **Expected results:** Only verified-owned and demonstrably safe resources can be deleted. Unknown, dirty/unpreserved, or uncertain resources remain intact and problems are reported; naming similarity or a failed remote read is insufficient authority.
- **Evidence:** Ownership/preservation facts, before/after worktree inventory and hashes, deletion ledger and diagnostic blocker.
- **Verification level:** Unit and integration.

### REQ-GIT-004 — Idempotent cleanup after merge

**Requirement ID:** REQ-GIT-004

#### VER-GIT-004-01 — Merge cleanup replay and already-deleted remote branch

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F; verified merge; owned safe local resources; remote branch present/deleted-by-GitHub variants; next task ready.
- **Steps:** Trigger cleanup; terminate after each deletion and before terminal recording. Restart and repeat completed cleanup actions; delay Trello `Done` verification.
- **Expected results:** Only owned safe local resources are removed. Confirmed remote branch absence after deletion is successful cleanup, not an outage/deletion assumption. Replays tolerate already-completed cleanup. `Done`/next selection follow required reconciliation; unsafe cleanup preserves artifacts and reports the problem.
- **Evidence:** Merged metadata, ownership checks, local/remote ref queries, deletion counts, terminal card reads and next claim timing.
- **Verification level:** Integration; realistic GitHub auto-deletion behavior in VER-TST-001-02.

### REQ-GIT-005 — Safe cleanup after an unmerged PR closes

**Requirement ID:** REQ-GIT-005

#### VER-GIT-005-01 — Retain accessible rejected history, then clean and retry fresh

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; closed-unmerged PR with remote implementation accessible; inaccessible-history variant; newer default branch/current card/attachments for retry.
- **Steps:** Verify closure and preservation through the closed PR; trigger local cleanup, restart/replay, then explicitly requeue. In the negative variant make preservation unverifiable.
- **Expected results:** Verified unmerged closure leads to `Backlog`. Only safe owned local resources are removed after accessible implementation is verified; uncertain preservation prevents deletion. Retry uses latest accepted default branch and current context, not automatic reuse of rejected changes; prior PR is optional historical evidence, not presumed correct.
- **Evidence:** Closed PR/commit accessibility, local deletion checks, retry base/diff/context and preserved history links.
- **Verification level:** Integration and end-to-end (realistic, required for closed-PR accessibility assumptions).

### REQ-GIT-006 — Clean manual retries after failure

**Requirement ID:** REQ-GIT-006

#### VER-GIT-006-01 — Isolate failed work from fresh attempt

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F; failed attempt with unfinished unique code, logs, records, stale worktree/session/lock; safely reconciled ownership; new default-branch commit and changed card/attachments.
- **Steps:** Poll while `Failed`, then explicitly move to `Ready for Agent`. Start new attempt without manual runtime-file edits; inspect old and new artifacts.
- **Expected results:** No automatic retry precedes the move. New attempt has clean worktree at latest default branch, current context, and distinct attempt identity/session handling. Prior unfinished code is not incorporated; prior changes/logs/records stay preserved or isolated. Reconciled stale artifacts do not permanently block the attempt.
- **Evidence:** Old/new base SHAs/diffs/worktree identities, old artifact hashes, current context, claim and reconciliation history.
- **Verification level:** Integration and end-to-end (simulated services).

## Configuration and project ownership (REQ-CFG)

### REQ-CFG-001 — Validate configuration and external resources before processing

**Requirement ID:** REQ-CFG-001

#### VER-CFG-001-01 — Fail startup before task side effects

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; configurations with zero projects, missing settings, invalid values, unsupported options, invalid board/list, and valid controls; ready cards present.
- **Steps:** Start each configuration. For resource checks, return confirmed invalid resources separately from unavailable reads. Inspect all task mutations and process starts.
- **Expected results:** At least one valid project is required. Missing/invalid/unsupported configuration or confirmed invalid required resources causes actionable startup error before any partial task execution. Required board/list checks precede processing. Unavailable reads never count as resource validity or nonexistence.
- **Evidence:** Configuration/error outputs, resource-check ledger, zero task mutation/agent/setup invocations on invalid startup and successful valid control.
- **Verification level:** Unit and integration.

### REQ-CFG-002 — Isolate project configuration and runtime failures

**Requirement ID:** REQ-CFG-002

#### VER-CFG-002-01 — Independent projects on Trello Free

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; distinct boards/repos/auth/commands; valid startup; Trello Free capability profile; realistic board on Free plan.
- **Steps:** Execute A and B concurrently; expire A credentials or make A resources unavailable at runtime. Exercise required Trello operations using Free capabilities.
- **Expected results:** No state/repository/configuration crosses projects. B continues despite A's scoped runtime failure. No required feature invokes or depends on paid Trello functionality; confirmed capability limitations are not hidden by substitutes.
- **Evidence:** Project-tagged state/requests/diffs, B progress during A outage, Trello operation/capability inventory and real Free-plan observations.
- **Verification level:** Integration and end-to-end (realistic, required for Free-plan compatibility).

### REQ-CFG-003 — Enforce exclusive project ownership

**Requirement ID:** REQ-CFG-003

#### VER-CFG-003-01 — Competing local and container instances

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F; two instances on one host configured for the same project; local/local, local/container, and container/container variants with shared integrations under identical/different aliases, shared/disjoint task-state directories, and a common or missing host-visible ownership namespace.
- **Steps:** Race startup/claim; hold owner active; make ownership ambiguous; crash owner and attempt recovery. Repeat with graceful shutdown and restart.
- **Expected results:** At most one instance processes the canonical project integration regardless of alias or task-state directory; missing shared coordination must fail safely. The losing instance neither claims nor mutates its task. Ambiguity blocks competing execution. Verified owner death/release allows safe recovery without a required shared database; unknown live processes are not killed or stolen.
- **Evidence:** Host/container process identities, ownership records, claim and mutation intervals, remote/card effects and recovery verification.
- **Verification level:** Unit and integration in actual local/container processes.

### REQ-CFG-004 — Load configuration at startup only

**Requirement ID:** REQ-CFG-004

#### VER-CFG-004-01 — Configuration changes require safe restart

- **Coverage:** AC1, AC2, AC3, AC4; also REQ-CFG-005 AC3.
- **Preconditions:** F; active task; identifiable command/model/polling values at startup; alternate valid configuration.
- **Steps:** Change settings during execution; observe several operations/polls. Restart with new operational settings during an in-progress task and reconcile safely. Separately try changing project aliases, removing an active project, redirecting its Trello/GitHub identity, and relocating runtime state while the PR remains open. Attempt relocation both without and alongside a compatible state-schema upgrade.
- **Expected results:** Running behavior uses its validated startup snapshot. Compatible settings take effect only after restart; active identity and original external references stay pinned. Incompatible identity/storage changes are rejected or deferred until a verified terminal outcome, not used to orphan existing ownership. Compatible state-schema upgrades at the pinned location do not authorize relocation of active state. No silent reset or lost work occurs.
- **Evidence:** Startup configuration fingerprints, original/resolved runtime locations and ownership references, invocation/poll timings, file-change/restart times, task/session identity and preserved diffs.
- **Verification level:** Integration.

### REQ-CFG-005 — Persist runtime state outside Git repositories

**Requirement ID:** REQ-CFG-005

Shared scenario VER-CFG-004-01 verifies AC3 by attempting incompatible runtime relocation while a task remains active.

#### VER-CFG-005-01 — Durable configurable runtime storage

- **Coverage:** AC1, AC2, AC4.
- **Preconditions:** F; non-container-specific custom runtime paths locally and persistent container volume; active task.
- **Steps:** Record task/session/recovery state; restart, recreate the container using its persistent storage, and upgrade with supported state. Exercise routine recovery through normal operation/Trello actions.
- **Expected results:** Runtime execution state stays outside source/worktree Git content and survives all supported restarts/upgrades. Configured paths work in both environments. Routine recovery requires no manual internal-file edits.
- **Evidence:** Actual resolved storage paths, Git status/diff, persistent state/session references, volume identity and recovery action record.
- **Verification level:** Integration in local/container environments; upgrade compatibility also uses VER-REC-005-02.

### REQ-CFG-006 — Verify required startup dependencies

**Requirement ID:** REQ-CFG-006

#### VER-CFG-006-01 — Tool accessibility, compatibility, and optionality

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; controlled executable search path; Git/OpenCode/GitHub CLI missing, inaccessible, incompatible, and valid versions; optional-feature dependency toggles.
- **Steps:** Start each required-tool variant; enable/disable each optional feature with its dependency absent. Inspect task starts.
- **Expected results:** Required tools are checked for presence/access/compatibility before tasks. Mandatory failures prevent processing with actionable startup error. Disabled-feature dependencies are not required; enabled mandatory dependencies cannot fail first halfway through a task.
- **Evidence:** Tool/version/access probes, enabled feature configuration, error messages, zero task side effects for rejected startup and valid-control progress.
- **Verification level:** Unit and integration.

## Project scheduling and polling (REQ-SCH)

### REQ-SCH-001 — One active task per project

**Requirement ID:** REQ-SCH-001

#### VER-SCH-001-01 — Exclusive task through every active phase

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; multiple eligible cards; active implementation/refinement/recovery/maintenance/human-review variants.
- **Steps:** Poll and attempt concurrent claims in every phase. Complete separate runs with verified `Done`, genuine `Failed`, closed-PR `Backlog`, or successful refinement `Backlog`; delay terminal readback.
- **Expected results:** One active task and coordinated operations per project; open PR blocks next claim. Only confirmed terminal outcomes release ownership, explicitly including successful refinement `Backlog` under REQ-SCH-001 AC3. A pending terminal transition never releases early.
- **Evidence:** Claim/ownership and operation intervals, task identities, PR/card states, terminal readback and next claim order.
- **Verification level:** Unit and integration.

### REQ-SCH-002 — Optional global AI concurrency limit

**Requirement ID:** REQ-SCH-002

#### VER-SCH-002-01 — Capacity, pending state, and human-review release

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F expanded to several projects; barriers hold AI work; explicit cap and no-cap variants; ready order recorded.
- **Steps:** Start all projects; measure concurrent AI activity. Let one enter `Human Review`, restart a capacity-waiting project, then release more slots. Repeat without global cap.
- **Expected results:** Explicit cap is respected alongside one task per project. Pending projects retain their task/order/state. Human review releases AI capacity but retains project ownership. No orchestrator cross-project cap applies when unset; eligible projects can execute concurrently subject only to actual external/environment capacity.
- **Evidence:** AI operation intervals/peak concurrency, configuration, pending order/state before/after restart and active task counts.
- **Verification level:** Unit and integration.

### REQ-SCH-003 — Fair first-come, first-served scheduling

**Requirement ID:** REQ-SCH-003

#### VER-SCH-003-01 — Busy project cannot bypass earlier waiters

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F expanded to A/B/C; global AI capacity one; B then C waiting before A requests another execution operation; no priority settings.
- **Steps:** Release A's slot, requeue A work, and release subsequent slots repeatedly. Record arrival order and restart while waiters are persisted where relevant.
- **Expected results:** Available capacity follows first-come, first-served order; A cannot repeatedly jump B/C. Waiting state/order is preserved and no project-priority configuration is necessary.
- **Evidence:** Arrival/slot grant timestamps and stable queue order, pending-state snapshots, absence of overlapping AI slots.
- **Verification level:** Unit and integration.

### REQ-SCH-004 — Automatic polling with controlled backoff

**Requirement ID:** REQ-SCH-004

#### VER-SCH-004-01 — Discover changes without restarting or interfering

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** F; default interval and one custom global interval; active operation held at barrier; controlled service clock.
- **Steps:** Add eligible card, feedback, CI outcome, and PR state change between polls. Inject transient API errors and recovery while the active operation runs.
- **Expected results:** Changes are found automatically. Unconfigured interval is 15 seconds; configured single interval applies globally without requiring per-project intervals. Errors produce controlled backoff; polling queues relevant work without interrupting or concurrently mutating the active task.
- **Evidence:** Request times, effective interval/backoff, observed change IDs, queued work and operation intervals.
- **Verification level:** Unit and integration.

## Logging and diagnostics (REQ-LOG)

### REQ-LOG-001 — Traceable task execution history

**Requirement ID:** REQ-LOG-001

#### VER-LOG-001-01 — Reconstruct success, failure, retry, and recovery

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; one successful task and one failed/recovered task with known event times/results.
- **Steps:** Exercise transitions, retries, validation/review, recovery, completion/failure and restart. Independently reconstruct each timeline from retained records and compare with external observer ledger.
- **Expected results:** Project/task-organized history includes transitions, errors, retries, recovery decisions, quality results, and duration. Records remain accessible after all outcomes/restart within retention. Summaries reference relevant separate process logs; missing execution is not reported as performed.
- **Evidence:** Persisted/log paths, sanitized event records, duration calculation, child-log references and independent timeline comparison.
- **Verification level:** Integration.

### REQ-LOG-002 — Separate structured and raw process logs

**Requirement ID:** REQ-LOG-002

#### VER-LOG-002-01 — Process streams remain separate on every exit path

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; OpenCode, Git, validation, setup, and other enabled child commands emit distinct stdout/stderr/stream markers; secret canaries handled under VER-SEC-002-01.
- **Steps:** Run success, failure, crash, timeout, and partial-stream variants. Inspect structured orchestrator events and separate process recordings.
- **Expected results:** Child stdout/stderr/streaming output is captured separately even on failure; no raw marker/output is copied into structured logs. Structured summaries are concise, sanitized, and may reference process logs. Sensitive portions remain protected, not exempted as raw output.
- **Evidence:** Stream marker inventory, structured events, separate log files and references, sanitized leak-scan results.
- **Verification level:** Integration with actual child processes.

### REQ-LOG-003 — Configurable safe retention

**Requirement ID:** REQ-LOG-003

#### VER-LOG-003-01 — Retention boundaries protect active evidence

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; logs just younger/older than 30 days and an explicit alternate retention; completed, failed, and active tasks with old logs.
- **Steps:** Run automatic retention under controlled time, restart, and repeat cleanup. Complete an old active task and advance beyond retention.
- **Expected results:** Default is 30 days; configured global value overrides it. Expired inactive logs are removed automatically; active-task logs are never deleted by age, including recovery/waiting tasks. Repeated cleanup is safe.
- **Evidence:** Effective retention/clock, task active status, before/after log inventory and cleanup events.
- **Verification level:** Unit and integration.

## Email notifications (REQ-NOT)

### REQ-NOT-001 — Supported notification events

**Requirement ID:** REQ-NOT-001

#### VER-NOT-001-01 — Event and optional-delivery matrix

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; controlled email sink; notifications configured and disabled variants.
- **Steps:** Produce refinement completion, normal/draft PR readiness, attention required, and genuine task failure. Inspect actual delivered messages, not merely queued events.
- **Expected results:** All four supported configured events deliver useful project/task identity and relevant links/context. Draft readiness explicitly identifies draft and outstanding issues. Disabled email does not prevent workflow progress or require email infrastructure.
- **Evidence:** Sink delivery count/headers/body, event/task IDs, linked resources, configuration and workflow outcomes.
- **Verification level:** Integration; end-to-end (realistic) requires actual configured email transport to controlled inbox.

### REQ-NOT-002 — Non-blocking and safe delivery

**Requirement ID:** REQ-NOT-002

#### VER-NOT-002-01 — Delivery rejection, uncertain acceptance, and restart

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; notification events; email rejects before acceptance or accepts then loses response; restart boundaries controllable.
- **Steps:** Fail transport during successful PR/refinement and failure notification paths; restart while pending; restore delivery and inspect recipients across repeated retries.
- **Expected results:** Email failure is logged without undoing/changing task outcome or blocking publication. Confirmed non-delivery is retried safely and confirmed delivered events are deduplicated. Possible acceptance with lost acknowledgment is preserved and reconciled through provider evidence if supported; otherwise the uncertainty is reported without blind resend or an exactly-once receipt claim.
- **Evidence:** Workflow/card/PR outcome before and after failure, event identity/delivery ledger, recipient message count and retry records.
- **Verification level:** Unit and integration; realistic transport ambiguity requires controlled end-to-end fault injection.

## Authentication and secrets (REQ-SEC)

### REQ-SEC-001 — Protected credential sources

**Requirement ID:** REQ-SEC-001

#### VER-SEC-001-01 — Credential sources, least exposure, and safe auth errors

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; unique synthetic credentials from environment and protected secret files; process-specific allowed credential manifest; committed settings containing no credentials.
- **Steps:** Start with each supported source; inspect settings/commits and actual child environments for Git, OpenCode, validation, and other enabled commands. Inject authentication and authorization errors.
- **Expected results:** Credentials originate from protected sources, not committed settings. Each child receives only needed credentials, never the full unrelated credential set. Errors clearly identify affected operation/project and remediation without revealing sensitive values.
- **Evidence:** Sanitized source/permission checks, credential-name allowlist comparisons, repository secret scan and sanitized error reports.
- **Verification level:** Unit and integration; realistic App/PAT behavior under VER-SEC-003-01.

### REQ-SEC-002 — Prevent sensitive data disclosure

**Requirement ID:** REQ-SEC-002

#### VER-SEC-002-01 — Canary scan across every output and recovery path

- **Coverage:** AC1, AC2, AC3, AC4, AC5.
- **Preconditions:** F; distinct synthetic secret canaries in credential sources, child output, service errors, and contextual material likely to be forwarded; no actual credentials in test evidence.
- **Steps:** Exercise planning, implementation, reviews, command failure, PR creation/update, Trello comments, email, crash recovery and auth errors. Capture all outbound prompts/payloads and persisted/rotated logs, including raw child streams. Scan configured and registered canaries and known encodings; separately test unnecessary credential propagation and untrusted attachments/repository content. Record untested forms explicitly.
- **Expected results:** Known configured credentials and tested representations do not appear in controlled logs, prompts, comments, PRs, email or recovery reports, and unnecessary processes do not receive credentials. Sensitive contextual inputs are not automatically treated as safe. Useful sanitized diagnostics remain. Passing canary tests never claims detection of arbitrary unknown or transformed secrets.
- **Evidence:** Sanitized per-surface scan report and redacted payload/log samples, process credential allowlist and preserved diagnostic references; never reproduce canaries in the result report.
- **Verification level:** Unit and integration; realistic outbound capture/redaction checks required before live-security claims.

### REQ-SEC-003 — Per-project GitHub authentication

**Requirement ID:** REQ-SEC-003

#### VER-SEC-003-01 — App and personal credentials coexist

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; A configured with GitHub App installation credentials and B with personal access token; separate disposable repositories and permissions.
- **Steps:** Execute GitHub read/write workflow for both concurrently; expire/revoke A authorization at runtime, then restore it. Inspect documented preference and actual ability to use personal credentials independently.
- **Expected results:** Each project uses its selected identity without credential crossover. App is preferred but not mandatory; personal credentials work. Scoped auth failure is clear/sanitized and B continues; restoration safely reconciles A.
- **Evidence:** Actor/installation identity, sanitized auth metadata, actual PR/service actions, scoped error/recovery and B's timeline.
- **Verification level:** Integration and end-to-end (realistic, required for actual authentication support).

## Runtime environment and agent configuration (REQ-ENV)

### REQ-ENV-001 — Local and Docker parity

**Requirement ID:** REQ-ENV-001

#### VER-ENV-001-01 — Same lifecycle locally and in a container

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F in local installation without Docker availability and in Docker-compatible deployment with persistent volumes; custom non-default paths.
- **Steps:** Execute the same implementation/PR/human-feedback/terminal workflow and restart recovery in both environments. Exercise Git, logs, and state persistence; compare behavioral evidence.
- **Expected results:** Both environments support equivalent outcomes, safety, task execution, Git operations, logs, and recovery. Configured runtime paths work without container-only assumptions; local execution does not require Docker.
- **Evidence:** Environment/runtime/version manifests, commands, path/volume resolution, lifecycle outcome matrix and persisted artifacts.
- **Verification level:** Integration and end-to-end (realistic in both environments); simulated parity alone cannot prove live parity.

### REQ-ENV-002 — Optional project setup command

**Requirement ID:** REQ-ENV-002

#### VER-ENV-002-01 — Setup ordering, project isolation, and resume

- **Coverage:** AC1, AC2, AC3, AC4, AC5, AC6, AC7.
- **Preconditions:** F; setup configured only for A; refinement and implementation variants; setup marker/exits observable.
- **Steps:** Run tasks with setup success, failure, timeout, and absent configuration. Interrupt before/during setup and after verified setup completion; resume safely. Test tracked setup-generated lockfiles (relevant and unrelated) and setup failure before and after an open PR exists.
- **Expected results:** Configured setup runs in the correct isolated task worktree before refinement/implementation, never original checkout. Output/failures are captured separately; failed configured setup prevents agent start, uses bounded safe recovery, and preserves changes and diagnostics. Unrecoverable pre-PR setup ends in verified failure; post-PR failure preserves the PR and ownership as a reported blockage. Verified successful setup is not unnecessarily rerun. Unconfigured setup is skipped, not passed. Setup-generated content is independently recorded; only reviewed task-relevant tracked changes may enter implementation commits, with unrelated setup changes preserved but excluded. The refinement agent makes no repository changes.
- **Evidence:** Invocation directory/project/order, marker counts, actual exit/logs, setup completion record and resumed operation timeline.
- **Verification level:** Unit and integration.

### REQ-ENV-003 — Per-activity OpenCode model and variant selection

**Requirement ID:** REQ-ENV-003

#### VER-ENV-003-01 — Explicit selection, defaults, and unavailable models

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; distinct project/activity selections for refinement, planning, implementation, independent review, remediation, and commit messages; omitted model/variant combinations; unavailable explicit model.
- **Steps:** Exercise every activity in each project; inspect OpenCode requests and effective OpenCode defaults. Fail the explicitly selected unavailable model.
- **Expected results:** Explicit model and variant are respected independently per activity/project. Each missing setting defers to OpenCode's configured default, not an orchestrator fallback. Unavailable explicit model is reported without silent substitution; handling remains consistent with advisory versus primary/outage rules.
- **Evidence:** Sanitized requested/effective model/variant and session metadata, configuration matrix, errors and absence of substituted requests.
- **Verification level:** Unit and integration; end-to-end (realistic) required to demonstrate OpenCode default/selection behavior.

## Trello task context and communication (REQ-CTX)

### REQ-CTX-001 — Refresh and isolate attachment context

**Requirement ID:** REQ-CTX-001

#### VER-CTX-001-01 — Attachment revisions and access failures

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; supported image/document/log attachments; both refinement and implementation tasks; external attachment storage.
- **Steps:** Start work; replace/add/remove attachments before resume; resume and inspect available manifest/content. Inject download/auth/content access failure separately.
- **Expected results:** Supported current attachments are accessible in both workflows at start/resume, with changed content refreshed and removed content not misrepresented as current. Downloads remain outside repositories/worktrees; failures are reported, not silently ignored.
- **Evidence:** Trello attachment IDs/revisions and downloaded hashes/paths, context supplied/accessed, Git status and explicit access-error report.
- **Verification level:** Integration and end-to-end (realistic for Trello download and actual agent access).

### REQ-CTX-002 — Clarify genuinely incomplete tasks

**Requirement ID:** REQ-CTX-002

#### VER-CTX-002-01 — Recover intent from evidence or ask precisely

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; terse task inferable from repository/attachments and separate task missing an essential human decision; no invented requirement allowed.
- **Steps:** Run analysis for both; inspect evidence examined before any clarification. For truly unclear task, verify failure comment; human supplies missing information and explicitly requeues.
- **Expected results:** Terse task is not automatically rejected when evidence establishes intent. Truly essential missing information leads to actionable clarification comment and verified `Failed`; no invented scope. Clarification plus explicit requeue starts a fresh attempt with current context.
- **Evidence:** Context/read trace, independent ambiguity rubric, comment identifying missing decision, card transitions and new-attempt context/base.
- **Verification level:** Integration and end-to-end (realistic, human assessment of inference required).

### REQ-CTX-003 — Restrict Trello content mutations and comments

**Requirement ID:** REQ-CTX-003

#### VER-CTX-003-01 — Preserve card fields and avoid routine comment noise

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; original title/description/classification; implementation, validation, review, CI, maintenance, failure and publication paths.
- **Steps:** Run each activity with retries/restarts; compare all card field writes and comments against activity history. Use refinement as the authorized-field-update control.
- **Expected results:** Non-refinement activities never change title, description, or classification, including transient writes. Meaningful failure/clarification/publication/closure comments are allowed and deduplicated; routine checks/reviews/retries stay in detailed execution logs, not repeated card comments.
- **Evidence:** Field mutation ledger and original/current values, comment inventory with event rationale, fine-grained execution logs.
- **Verification level:** Integration and end-to-end (simulated services).

### REQ-CTX-004 — Reconcile unexpected manual Trello moves

**Requirement ID:** REQ-CTX-004

#### VER-CTX-004-01 — Pause and safely resume unexpected card state

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; active A task in `Working` or `Human Review`; B healthy; preserved edits/session; no orchestrator-intended move pending.
- **Steps:** Human unexpectedly moves A's card, including to a terminal-looking list; poll/restart. Return it to expected list; run safe-state and still-ambiguous variants.
- **Expected results:** Manual move is not credited as orchestrator success. A pauses further work, preserving state and preventing next task; B continues. Returned card can resume only after safety verification; remaining ambiguity is reported/preserved, not guessed away. Exact pause-boundary policy awaits A5.
- **Evidence:** Actor-attributed move history, preserved artifacts, project/operation timelines, safety verification and no false terminal release.
- **Verification level:** Integration; end-to-end (realistic) required for actual manual-move observation.

## Automated verification (REQ-TST)

### REQ-TST-001 — Automated coverage of critical workflows

**Requirement ID:** REQ-TST-001

#### VER-TST-001-01 — Complete reproducible lifecycle matrix

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; executable lifecycle driver using service substitutes, actual Git/process/storage, and observer assertions; all subordinate scenario fixtures available.
- **Steps:** Run complete paths: selection → setup/plan → implementation → validation/review → normal/draft PR → human changes → CI repair → safe maintenance → human merge → `Done`; independently run unmerged closure → `Backlog` → fresh retry, refinement → `Backlog`, primary unrecoverable failure → `Failed` → clean retry, and unclear/no-change task failures. Inject negative reviews, quality exhaustion, crash/restart, partial external success, and outages at their relevant boundaries. Verify every endpoint and side-effect count.
- **Expected results:** Complete paths demonstrate actual external-substitute state, Git changes and terminal synchronization, with no quality gate, silent `Working` abandonment, unsafe release, duplicate effect, or uncontrolled loop. Expected failures are distinguished from execution crashes/outages. Unit results alone cannot satisfy the lifecycle evidence obligation.
- **Evidence:** Driver inputs/version, full observer timeline, card/PR/session identities, remote Git objects/diffs, bounds, artifact preservation, and per-path results linked to subordinate scenarios.
- **Verification level:** End-to-end (simulated services), supported by unit/integration assertions; realistic obligation remains VER-TST-001-02.

#### VER-TST-001-02 — Realistic complete baseline

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** Isolated real Trello Free boards, disposable GitHub repos/CI, actual OpenCode and Git/commands, controlled email inbox, dedicated test identities; no production resources. Record manual semantic rubrics and a published-branch merge synchronization fixture preserving existing commit identities.
- **Steps:** Through normal application startup/polling, execute (1) meaningful passing implementation → normal PR → human requested change → CI repair → safe maintenance → approval while still open → human merge → `Done`; (2) real failing validation/negative advisory findings → draft publication → partial human correction with an unresolved request → unmerged human closure → `Backlog` → explicit fresh retry; (3) repository-grounded refinement → `Backlog`; (4) interrupt/restart a real active task and verify same-session/work preservation and no duplicate publication. Observe actual service readbacks, email and Git; inject a controlled temporary network interruption without asserting service-side behavior that cannot be observed.
- **Expected results:** Actual integrations sustain the complete agreed workflow and safety invariants, not just mocked contracts. Human outcomes remain human-controlled, failure disclosures are accurate, quality does not veto publication, recovery preserves work/identities, and Free-plan operations work. Record any inaccessible fault variant as partial/blocked; do not extrapolate live success from substitutes or claim A1 is resolved by skipping its divergent case.
- **Evidence:** Sanitized live resource URLs/IDs, API/readback timestamps, actor/PR/review/check metadata, actual remote commits/diffs, command exits, session continuity, card/comment snapshots, delivered email, restart trace, and human rubric assessments.
- **Verification level:** End-to-end (realistic, explicitly required). Run local/container parity through VER-ENV-001-01. A temporary isolated environment is sufficient; permanent live-test infrastructure is optional.

### REQ-TST-002 — Repeatable simulated external failures

**Requirement ID:** REQ-TST-002

#### VER-TST-002-01 — Offline fault matrix with independent oracles

- **Coverage:** AC1, AC2, AC3.
- **Preconditions:** F; routine test environment denies live Trello/GitHub/OpenCode network access; stateful substitutes and controlled clock; actual local Git/process execution.
- **Steps:** Execute success, rejection, accepted-but-response-lost mutation, timeout, delayed/missing result, and restart/recovery variants for each relevant service. Repeat from identical fixtures and compare outcomes.
- **Expected results:** Routine tests run without live services and reproducibly exercise failures/recovery. Assertions inspect PR/card counts/state, work preservation, sessions and bounded attempts. An agent's success claim or a mocked success response without observed state is insufficient.
- **Evidence:** Network-isolation record, fixture/fault scripts and seeds, request/effect ledger, independent state/Git snapshots, repeated results and attempt timings.
- **Verification level:** Integration and end-to-end (simulated services).

### REQ-TST-003 — Traceable compliance evidence

**Requirement ID:** REQ-TST-003

#### VER-TST-003-01 — Evidence and coverage accounting

- **Coverage:** AC1, AC2, AC3, AC4.
- **Preconditions:** Specification version, this plan, and an execution-record template; records may initially all be unexecuted.
- **Steps:** Extract requirement IDs and ordered acceptance bullets; compare with scenario Coverage entries and index. Check unique stable scenario IDs and all required fields. When executing, attach per-scenario/per-variant status and evidence, including realistic lifecycle results; distinguish missing levels. Recheck after source changes without recycling IDs.
- **Expected results:** Every acceptance criterion is explicitly mapped, requirements remain independently assessable, and demonstrated/partial/blocked/unexecuted coverage is honest. Realistic evidence is required in addition to units/mocks for baseline claims. A future dedicated live environment is not treated as a prerequisite to fixing robustness issues.
- **Evidence:** Versioned coverage matrix, uniqueness/field checks, execution records and links to real lifecycle evidence or explicit missing-evidence status.
- **Verification level:** Documentation/record inspection plus integration and end-to-end evidence review; no application compliance is inferred from document presence.

## Requirement-to-scenario index

Each row covers the named requirement; the scenario Coverage fields above provide the acceptance-criterion-level mapping. A range is inclusive. Indexing a scenario is a planned coverage claim, not a passed-test claim.

| Requirement ID | Verification scenarios                      |
| -------------- | ------------------------------------------- |
| REQ-WF-001     | VER-WF-001-01, VER-WF-001-02, VER-WF-001-03 |
| REQ-WF-002     | VER-WF-002-01, VER-WF-002-02                |
| REQ-WF-003     | VER-WF-003-01                               |
| REQ-PR-001     | VER-PR-001-01                               |
| REQ-PR-002     | VER-PR-002-01                               |
| REQ-PR-003     | VER-PR-003-01, VER-PR-003-02, VER-PR-003-03 |
| REQ-PR-004     | VER-PR-004-01                               |
| REQ-PR-005     | VER-PR-005-01                               |
| REQ-PR-006     | VER-PR-006-01                               |
| REQ-PR-007     | VER-PR-007-01                               |
| REQ-PR-008     | VER-PR-008-01, VER-PR-008-02                |
| REQ-TR-001     | VER-TR-001-01                               |
| REQ-TR-002     | VER-TR-002-01                               |
| REQ-TR-003     | VER-TR-003-01                               |
| REQ-TR-004     | VER-TR-004-01                               |
| REQ-REF-001    | VER-REF-001-01                              |
| REQ-REF-002    | VER-REF-002-01                              |
| REQ-REF-003    | VER-REF-003-01                              |
| REQ-REF-004    | VER-REF-004-01, VER-REF-004-02              |
| REQ-REF-005    | VER-REF-005-01                              |
| REQ-IMP-001    | VER-IMP-001-01                              |
| REQ-IMP-002    | VER-IMP-002-01                              |
| REQ-IMP-003    | VER-IMP-003-01                              |
| REQ-IMP-004    | VER-IMP-004-01, VER-IMP-004-02              |
| REQ-IMP-005    | VER-IMP-005-01                              |
| REQ-VAL-001    | VER-VAL-001-01                              |
| REQ-VAL-002    | VER-VAL-002-01                              |
| REQ-VAL-003    | VER-VAL-003-01                              |
| REQ-VAL-004    | VER-VAL-004-01                              |
| REQ-VAL-005    | VER-VAL-005-01                              |
| REQ-HR-001     | VER-HR-001-01                               |
| REQ-HR-002     | VER-HR-002-01                               |
| REQ-HR-003     | VER-HR-003-01                               |
| REQ-HR-004     | VER-HR-004-01                               |
| REQ-HR-005     | VER-HR-005-01                               |
| REQ-HR-006     | VER-HR-006-01, VER-PR-008-02                |
| REQ-CI-001     | VER-CI-001-01                               |
| REQ-CI-002     | VER-CI-002-01                               |
| REQ-MNT-001    | VER-MNT-001-01                              |
| REQ-MNT-002    | VER-MNT-002-01                              |
| REQ-MNT-003    | VER-MNT-003-01                              |
| REQ-MNT-004    | VER-MNT-004-01                              |
| REQ-REC-001    | VER-REC-001-01                              |
| REQ-REC-002    | VER-REC-002-01, VER-PR-003-03               |
| REQ-REC-003    | VER-REC-003-01                              |
| REQ-REC-004    | VER-REC-004-01                              |
| REQ-REC-005    | VER-REC-005-01, VER-REC-005-02              |
| REQ-REC-006    | VER-REC-006-01, VER-REC-006-02              |
| REQ-GIT-001    | VER-GIT-001-01                              |
| REQ-GIT-002    | VER-GIT-002-01                              |
| REQ-GIT-003    | VER-GIT-003-01                              |
| REQ-GIT-004    | VER-GIT-004-01                              |
| REQ-GIT-005    | VER-GIT-005-01                              |
| REQ-GIT-006    | VER-GIT-006-01                              |
| REQ-CFG-001    | VER-CFG-001-01                              |
| REQ-CFG-002    | VER-CFG-002-01                              |
| REQ-CFG-003    | VER-CFG-003-01                              |
| REQ-CFG-004    | VER-CFG-004-01                              |
| REQ-CFG-005    | VER-CFG-005-01, VER-CFG-004-01              |
| REQ-CFG-006    | VER-CFG-006-01                              |
| REQ-SCH-001    | VER-SCH-001-01, VER-PR-003-03               |
| REQ-SCH-002    | VER-SCH-002-01                              |
| REQ-SCH-003    | VER-SCH-003-01                              |
| REQ-SCH-004    | VER-SCH-004-01                              |
| REQ-LOG-001    | VER-LOG-001-01                              |
| REQ-LOG-002    | VER-LOG-002-01                              |
| REQ-LOG-003    | VER-LOG-003-01                              |
| REQ-NOT-001    | VER-NOT-001-01                              |
| REQ-NOT-002    | VER-NOT-002-01                              |
| REQ-SEC-001    | VER-SEC-001-01                              |
| REQ-SEC-002    | VER-SEC-002-01                              |
| REQ-SEC-003    | VER-SEC-003-01                              |
| REQ-ENV-001    | VER-ENV-001-01                              |
| REQ-ENV-002    | VER-ENV-002-01                              |
| REQ-ENV-003    | VER-ENV-003-01                              |
| REQ-CTX-001    | VER-CTX-001-01                              |
| REQ-CTX-002    | VER-CTX-002-01                              |
| REQ-CTX-003    | VER-CTX-003-01                              |
| REQ-CTX-004    | VER-CTX-004-01                              |
| REQ-TST-001    | VER-TST-001-01, VER-TST-001-02              |
| REQ-TST-002    | VER-TST-002-01                              |
| REQ-TST-003    | VER-TST-003-01                              |

## Ambiguities and decisions needed

These notes distinguish resolved findings from edge cases requiring representative fixtures or external-service capabilities. Execute unambiguous assertions even when an edge case remains unresolved.

The [readiness register](phase-readiness.md) assigns the unresolved portions below
to concrete owners and due-before tasks. An open edge oracle does not block unrelated
deterministic work. It does prevent claiming that edge's acceptance. Resolve a
current-phase prerequisite before its dependent task, rather than deferring all
A2/A5 decisions to P11. Record decisions and representative fixtures here by reference;
do not infer a product default from a test timeout or a fixture limit.

| Reference             | Affected requirements                                                          | Source tension or undefined oracle                                                                                                                                                                                                                                                                                                                                                  | Verification treatment                                                                                                                                                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 (resolved)         | REQ-MNT-002, REQ-GIT-002                                                       | Published PR branches merge target changes without rewriting published commits; only unpublished work may be rebased.                                                                                                                                                                                                                                                               | Verify retained commit ancestry and PR identity, merge conflicts, safe push and refusal, and no force-push.                                                                                                                                                                                                                                  |
| A2                    | REQ-REF-001–003, REQ-IMP-001–003, REQ-IMP-005, REQ-CTX-001–002                 | Supported attachment formats/limits, final template details, and semantic terms such as actionable, meaningful, necessary, task scope, appropriate attempts, and essential missing information are not exhaustively defined. The source explicitly leaves template details for later agreement.                                                                                     | Record approved representative fixtures and independent human rubrics; factual assertions use repository evidence. Fixture-specific demonstrations are possible, but exhaustive format/template coverage and subjective edge cases remain partial until those oracles are agreed. Do not invent a universal diff-size threshold or template. |
| A3 (resolved)         | REQ-PR-004, REQ-VAL-005, REQ-HR-004                                            | Normal readiness requires demonstrably passing configured checks and no known material unresolved issue, not reviewer approval.                                                                                                                                                                                                                                                     | Failing, skipped, uncertain or materially unresolved checks/findings imply draft with accurate disclosure; disregarded advice alone is not a publication veto.                                                                                                                                                                               |
| A4 (resolved)         | REQ-REF-001, REQ-REF-004, REQ-ENV-002                                          | Setup effects are distinct from read-only refinement; card original values and intended update are saved before writing, with reconciliation before terminal state if writes are uncertain.                                                                                                                                                                                         | Verify setup attribution, rejected and accepted-but-unacknowledged Trello writes, restored/complete field readback, and pending ownership until reconciliation.                                                                                                                                                                              |
| A5                    | REQ-WF-002–003, REQ-CI-001, REQ-REC-004, REQ-REC-006, REQ-CTX-004, REQ-SCH-004 | The source requires bounded operations, controlled delays, stall detection, expected-check observation, and safe resumption after manual moves, without fully specifying all defaults, progress indicators, expected-check discovery rules, alert thresholds, or precise manual-move recovery rules. Only stated defaults such as 15-second polling and 30-day retention are fixed. | Bind runs to recorded configured bounds and independently visible progress/check fixtures. Assert no busy loop, false pass, unsafe resume, or silent abandonment. Numeric edge behavior without a defined policy and precise pause/resume boundaries remain blocked pending agreement; do not invent new settings or task-wide deadlines.    |
| A6 (policy clarified) | REQ-NOT-002, REQ-WF-001                                                        | Retry confirmed non-delivery and deduplicate confirmed events; preserve ambiguous possible-delivery state unless provider evidence can reconcile it.                                                                                                                                                                                                                                | Verify no blind resend after possible acceptance, observable pending uncertainty, and no claim of exactly-once receipt without transport support.                                                                                                                                                                                            |

### Approved P6 portions of A2/A5 and execution authority

The user approved [D6-RECOVERY, D6-RUBRIC, D6-UPGRADE and D6-LIVE](p6-decisions.md).
For P6, A2 now has the representative inferable/essential-clarification,
meaningful/no-output and material/style issue rubric. A5 primary recovery accounting
is three verified genuine failures per semantic operation, with truthful dispatch
history and separate outage/reconstruction/improvement accounting. The earlier
three-total-executions wording is historical, not a competing interpretation.

Use these approved oracles to build concrete fixtures; approval does not establish
model performance or pass unexecuted realistic observations. A2's later attachment/
template/feedback details and A5's later CI, progress/stall and manual-move edge
policies remain with their named phases. Do not ask the user to approve the P6
portions again. Upgrade cohort and live-test permission are approved; actual artifact
inventory, resource access, finite run manifests and executable evidence are still
engineering work under the readiness register.

REQ-SCH-001 AC3 includes successful refinement returning to `Backlog`, covered by VER-SCH-001-01 and VER-REF-005-01.

## Execution record checklist

For each eventual scenario run, retain: scenario/requirement IDs and AC mapping; fixture and application revisions; level/environment; each executed parameter/fault variant; sanitized effective bounds; exact actions; independent before/after state and effect identities/counts; expected-versus-actual assertions; evidence locations; outcome and missing assertions; and any A1–A6 decision relied upon. Record realistic-level evidence separately from substitute evidence. Preserve earlier failed/partial records when rerunning, and do not mark a whole requirement demonstrated while an acceptance criterion, required variant, or required integration level is unexecuted or blocked.
