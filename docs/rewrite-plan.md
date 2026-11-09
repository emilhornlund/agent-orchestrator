# Agent Orchestrator — Architecture Rewrite Plan

## Executive summary

Evolve the existing implementation through bounded, reviewable changes around a single durable task-attempt authority and a serialized coordinator for each project. Retain useful Git guards, strict validation, attachment handling, session continuity, quality evidence, and tests. Replace contradictory workflow policy and fragmented recovery incrementally rather than replacing the application wholesale.

This document defines the proposed architecture rewrite roadmap, not implementation authorization or a task backlog. [requirements.md](requirements.md) is authoritative; [specification.md](specification.md) supplies 82 stable requirement IDs and 305 acceptance criteria; [verification.md](verification.md) supplies planned scenarios; [implementation-audit.md](implementation-audit.md) supplies findings F1–F13 and implementation evidence at `7132b33`. The [implementation audit](implementation-audit.md) records the audited code baseline and evidence. Scenario mappings below are planned verification obligations, not executed results.

Recommended direction:

- The orchestrator owns deterministic transitions, ownership, attempts, safety, evidence, publication, and reconciliation. OpenCode owns engineering judgment, including whether advice warrants changes and whether a human request is actionable or materially changed.
- Human merge or closure is authoritative. Never automatically merge, force-push, rewrite published commits, or replace a PR to bypass problems.
- Meaningful completed implementation proceeds to safe PR publication despite adverse advisory results. Draft status and reporting reflect recorded issues; AI approval is not permission to publish.
- Durable intent precedes external mutations. Verification follows them. Unknown acceptance is a recoverable state, not permission to resend, roll back blindly, or release ownership.
- Distinguish a project owner, its active task attempt, a currently executing operation, and global AI capacity. An open PR occupies its project while consuming no AI slot between operations.
- Use versioned filesystem state and one host-visible coordination namespace. No shared database, generic provider framework, distributed coordination, new service infrastructure, or live configuration reload is needed.

Eleven phases deliver coherent improvements. Early phases establish safety, state, and execution boundaries; later phases move one workflow at a time onto them. Each phase may use several focused commits, but must have its own observable completion evidence. Incremental releases are permitted before full compliance, with remaining gaps disclosed and unsafe legacy routes prevented from running.

## Target architecture

### Component boundaries and state ownership

Names describe concrete responsibilities, not a requirement to rename working classes. Small domain functions should be extracted from existing coordinators when their policy or boundary becomes shared; do not introduce a generic workflow engine.

| Component                                    | Responsibility and boundary                                                                                                                                                                                                                | State authority                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Startup/configuration validation             | Parse one startup snapshot; verify enabled tools and configured resources; resolve canonical integration identities and pinned paths before claims. Separate confirmed invalid settings from temporarily unavailable project dependencies. | Validated process snapshot; durable active identity comes from ownership records, not current aliases.                                |
| Project ownership coordination               | Exclude competing local/container owners through a common host-visible namespace; record canonical identity, active attempt and pinned state location. Verify ownership before all processing, including idle PR observation.              | Durable project registry plus host-scoped exclusive ownership. A PID alone is insufficient across namespaces.                         |
| `Orchestrator`                               | Observe Trello/GitHub, enqueue events, select allowed transitions, coordinate recovery and terminal precedence. One writer per project; observation continues during long operations.                                                      | Decides transitions from persisted evidence; neither card position nor a worker's local memory alone is authoritative workflow state. |
| `RunStore`                                   | Consolidate `TaskExecutionStore` semantics into a revision-checked, versioned attempt record; persist operation intents, queue entries, outcomes, budgets and checkpoints. Keep large artifacts separately with durable references.        | Authoritative orchestration state. External services remain authoritative for whether their effects occurred.                         |
| `GitRepository` / existing `GitClient`       | Inspect refs/content; fetch, commit, merge, and fast-forward-safe push; verify published history and uncertain commits/pushes. Never change source checkout files, index, HEAD, or checked-out branch.                                     | Git objects and refs are authoritative repository evidence; durable attempt references establish provenance.                          |
| `WorktreeManager`                            | Create attempt-specific worktrees, prove common-repository/path/branch ownership, preserve failed/unshipped work, and perform verified idempotent cleanup.                                                                                 | Owned-resource manifest in the attempt, checked against actual Git/filesystem state.                                                  |
| `OpenCodeRunner` / existing `OpenCodeClient` | Run bounded activities with appropriate permissions, model selection and context. Restore primary session first; reconstruct only after confirmed loss and sufficient context. Independent reviews use separate sessions.                  | Persist session creation/binding intents and context references in `RunStore`; OpenCode is authoritative for session availability.    |
| Process execution and diagnostics            | Share cancellation, process-tree termination, operation timeouts, credential allowlists, redaction and separate process recordings across OpenCode, Git, gh, setup and quality commands.                                                   | Durable execution identities/results and artifact references; raw streams never become structured workflow events.                    |
| `TrelloClient`                               | Typed Free-plan card/list/label/attachment reads and mutations; expose returned fields and available history for verification. Content updates belong only to refinement.                                                                  | Trello card state and history, not an assumed successful move.                                                                        |
| `GitHubClient`                               | Per-project App/personal authentication; PR/check/feedback observation and safe publication/status/replies. No automatic merge or conversation-resolution action.                                                                          | GitHub PR outcome, identities, heads and feedback revisions.                                                                          |
| Notification delivery                        | Four optional event types; durable delivery records, safe retries, uncertain acceptance and deduplication. Delivery failure cannot undo workflow success or block publication.                                                             | Notification event identity and observed transport outcome, distinct from task completion.                                            |

### Workflow coordination

Keep three related state dimensions explicit instead of adding one phase for every combination:

1. **Attempt lifecycle:** selected/claim pending, preparing, implementing or refining, published/active PR, terminal synchronization pending, verified terminal outcome.
2. **Operation:** kind, unique identity, queue priority, prerequisites, expected attempt revision/generation, execution status, budgets, content/session references and completion evidence.
3. **Wait/recovery:** resumable checkpoint, reason, affected dependency, next controlled recheck, bounded immediate recovery attempts, last meaningful progress, and alert identity. Human review, capacity wait, external uncertainty, manual move and intervention-required blockage are distinguishable.

Implement an explicit state/event/allowed-transition matrix before replacing routes. A single transition function validates writes to the authoritative record; operation completions carry an ownership/generation token so a stale process cannot advance a superseded attempt. This is local fencing, not a claim that remote APIs support fencing or atomicity.

The project queue serializes all branch and task mutations. Terminal reconciliation supersedes queued work. Otherwise human changes precede CI repairs, then routine maintenance; necessary prerequisites may run first with an evidence-backed reason. Observation can persist arrivals while an operation runs, but cannot start another branch writer. New feedback does not interrupt an active OpenCode operation; verified human merge/closure triggers safe interruption and reconciliation of already-dispatched effects.

New tasks are selected from current top-to-bottom eligible `Ready for Agent` cards, revalidated at claim time. A verified terminal outcome releases the active-task claim. Host instance exclusion can remain held while the process serves that project. A deliberate requeue creates a new attempt, never resumes failed code implicitly.

### Durable state and external effects

Use one atomic, revision-checked attempt envelope for the small pieces that must agree: project/attempt identity, lifecycle, active operation, pending queue, session references, external resource identities, expected Trello state, correction episodes and pending mutations. Large plans, context snapshots, process output, and immutable event records live outside Git and are referenced by identity/hash. Write artifacts before referencing them; tolerate orphan artifacts after interruption. Do not implement full event sourcing or replay external commands from log messages.

Retain the existing validated temporary-write/fsync/atomic-replacement approach, adding safe lock ownership and supported migrations. The canonical project registry points to pinned attempt storage. Registry/attempt changes themselves require ordered, recoverable handoffs: create the attempt before publishing its registry pointer, and reconcile incomplete handoffs on startup. They are not a cross-file atomic transaction.

Every external mutation uses the same small persisted intent/outcome vocabulary, with service-specific reconciliation:

| Mutation class                             | Examples                                                                                           | Recovery rule                                                                                                                                                                                                                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Safely repeatable desired state            | Setting a verified card list or draft status, where current state and concurrent changes permit it | Read authoritative state; verify intended fields and allowed transition before repeating or recording completion.                                                                                                                                                                              |
| Discoverable resource/effect               | PR creation by repository/head/base and attempt identity; commit/push by recorded objects/refs     | Persist intent before dispatch; discover and bind the actual identity before subsequent steps. Preserve accepted effects if later steps fail.                                                                                                                                                  |
| Potentially ambiguous non-idempotent write | Trello comment, GitHub reply, SMTP message                                                         | Use provider idempotency when available or stable correlation markers and discovery evidence. A timeout followed by absence does not authorize resending an in-flight request. Keep uncertainty and controlled rechecks; request operator resolution if the provider cannot establish outcome. |

Store intended payload identity, correlation/resource identity, dispatch status, observed outcome and verification evidence. Reconciliation must account for late acceptance, not only the next immediate read. Do not promise unconditional exactly-once effects. Pending workflow mutations retain project ownership; notification-only uncertainty remains in its delivery record and does not hold task completion hostage.

Refinement additionally records original fields, intended complete result, verified writes, available human edits and history. Compare before writing and inspect fields/history afterward. Detected conflict pauses writes. Compensation restores only what can safely be attributed; it is not a transaction rollback and must not overwrite human changes.

### Policy, quality and context boundaries

- Record quality results as passed, failed, skipped or uncertain with content identity and diagnostics; record review findings and material-issue dispositions separately from a review verdict. The agent evaluates semantic significance; the orchestrator applies explicit evidence/reporting rules and never requires an AI approval token.
- Validation, AI-review and CI correction budgets are separate configured maxima. Persist attempts before dispatch. Early finish or unchanged implementation ends improvement normally. Primary recovery uses the existing bounded operation retry policy, not a new crash setting.
- A CI episode is identified by its verified initiating event, not head SHA. Self-generated commits, polls, reruns and routine synchronization retain the budget. Only genuinely new human work or a materially new independent failure can establish a new episode.
- Before a PR exists, unrecoverable primary execution, unrecoverable configured setup, essential missing task information, no meaningful output or genuinely unsafe Git state may lead to verified `Failed`. Preserve partial code. Do not publish crashed primary work merely because a diff exists. After publication, an unrecoverable correction is an explicit blockage preserving the PR and ownership, never task failure while that PR is open.
- Temporary essential dependency outages preserve and recheck; exhausted advisory dependency failures are reported and skipped. No task-wide deadline is introduced.
- Refresh task and attachment context at start/resumption of every relevant primary activity, including CI repair. Keep attachments, plans and reconstruction evidence outside repositories; report access failures. Context inputs are untrusted, with least-privilege credentials and checked controlled output channels.
- Setup precedes refinement/implementation when configured and records its effects independently. The agent decides which tracked setup changes are task-relevant; publication excludes unrelated changes without deleting them. Unsafe or uncertain disposition blocks publication for scope safety, not quality approval.
- Generate current PR descriptions from implementation and observed evidence, with a deterministic complete fallback. Managed content preserves human text; activity status sits at the top, changes with activity and clears on completion. Refresh/reconcile concurrent body edits conservatively rather than claiming atomic read-modify-write.

### Reuse versus replacement

| Existing mechanism and audit evidence                                                                                         | Direction                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strict Zod parsing, startup Trello checks, App/PAT support (F8, F12)                                                          | Retain; add missing optionality/defaults, dependency checks, identity pins and scoped runtime isolation. Preserve already-supported REQ-CFG-001 and REQ-SEC-003.                                                  |
| `TaskExecutionStore` atomic writes/revisions and transition functions (F5)                                                    | Extend into `RunStore`; migrate, do not delete, old records. Eliminate coordinator bypasses of transition authority as each route moves.                                                                          |
| Mutation queue, feedback ledger, maintenance/commit intents and authoritative recovery snapshots (F3–F6, F9)                  | Reuse evidence and deterministic checks; consolidate small coordination fields under one authority. Replace alias-only locks, disconnected block files and inference from last phase.                             |
| Worktree guards, source snapshots, non-fast-forward refusal, trusted/pending commit reconciliation and real-Git fixtures (F4) | Retain and strengthen with attempt provenance and unshipped-commit preservation. Replace published rebase/leased push with merge plus ordinary push.                                                              |
| Primary-session creation/binding and separate reviewers (F5, F9)                                                              | Retain; add bounded reconnect, confirmed-loss reconstruction and consistent refreshed context.                                                                                                                    |
| Attachment staging/manifests/rollback and URL credential restrictions (F9)                                                    | Retain; refresh consistently and establish realistic format/agent-use evidence.                                                                                                                                   |
| Command timeout/process-group handling and streaming redaction (F5, F12)                                                      | Reuse common execution mechanics; extend to Git/gh/bootstrap and least-privilege input/output boundaries.                                                                                                         |
| Exact-content validation/coverage/review evidence, conservative CI expectations (F1–F2)                                       | Retain evidence, replace approval gates, hardcoded budgets, SHA-based episodes and indefinite CI waiting.                                                                                                         |
| Refinement result parsing, distinct templates and concise completion builders (F7)                                            | Retain; replace unjournaled finalization and worktree result-file mutation with recoverable, human-edit-aware updates and external result storage.                                                                |
| Managed PR sections/status renderers and notification builders (F10–F11)                                                      | Retain rendering; wire every route, complete fallback evidence, add durable delivery outcomes, and replace pre-send “delivered” claims.                                                                           |
| Mocked dispatch/unit suites and selected actual Git/process tests (F13)                                                       | Reuse valid fixtures/assertions. Replace tests that require auto-merge, force-push, approved plans or passing publication checks with requirement-derived oracles; keep equivalent preservation/failure coverage. |

## Implementation phases

Implementation is governed by the [execution protocol](phase-execution.md), the
[current milestone ledger](phase-status.md), the [readiness register](phase-readiness.md),
and the selected phase packet below. Readiness tasks may begin immediately;
dependent implementation begins only after its prerequisites are demonstrated.
The user closed the P5 delivery milestone and requested PR #218. Its historical
verification findings remain evidence and explicit carryovers, not an automatic
instruction to reopen P5 or claim full product qualification.

### Phase dependencies and review rules

| Phase | Deliverable                                                | Depends on |
| ----- | ---------------------------------------------------------- | ---------- |
| P1    | Invariant guardrails and observable regression harness     | None       |
| P2    | Canonical ownership, attempt state and safe schema handoff | P1         |
| P3    | Shared safe process, diagnostics and credential boundaries | P2         |
| P4    | Durable external-mutation reconciliation                   | P2, P3     |
| P5    | Recovery-first execution, setup and session context        | P3, P4     |
| P6    | Advisory implementation and truthful publication           | P4, P5     |
| P7    | Active-PR observation, queue and human feedback            | P6         |
| P8    | Bounded CI episodes and additive PR maintenance            | P7         |
| P9    | Recoverable, read-only refinement                          | P5, P6     |
| P10   | Terminal artifacts, cleanup and clean deliberate retries   | P7, P8, P9 |
| P11   | Complete lifecycle evidence and release closure            | P10        |

P9 can be developed after P6 independently of P7/P8; production handoff still uses one writer. Every phase inherits the verification protocol, fault boundaries, evidence levels and outcome labels in `verification.md`. Its packet assigns criterion/variant ownership before implementation: an earlier contribution does not require implementing a later-owned workflow, and it does not pass that later variant. Run `yarn validate` through the designated runner, plus owned scenarios at their stated levels. Arrange required realistic evidence at readiness; missing resources or decisions are surfaced before dependent work. Do not silently move required live evidence to P11. P11 composes and qualifies the full release; it is not the first end-to-end check. Follow the protocol for task, phase-owned, and release qualification outcomes.

| Phase | Execution packet                  | Entry focus                                                                                        |
| ----- | --------------------------------- | -------------------------------------------------------------------------------------------------- |
| P6    | [P6 execution](p6-execution.md)   | Initial publication policy, source-checkout boundary, budget semantics, P5 carryovers              |
| P7    | [P7 execution](p7-execution.md)   | Observer/writer authority, capacity lifecycle, feedback classification and expected-list migration |
| P8    | [P8 execution](p8-execution.md)   | Expected CI, episode identity, additive maintenance with preserved work                            |
| P9    | [P9 execution](p9-execution.md)   | Free-plan history capability, approved fixtures, external read-only output and compensation        |
| P10   | [P10 execution](p10-execution.md) | Terminal obligations, resource provenance, supported upgrades and fresh-attempt handoff            |
| P11   | [P11 execution](p11-execution.md) | Finite release matrix, authorized live/local/container environments, legacy retirement             |

### P1 — Establish invariant guardrails and an observable regression harness

**Scope:** Establish requirement-derived policy contracts, the operation/transition inventory and fixtures before structural replacement. Remove automatic-merge execution and published force-push/rebase paths. Explicitly reject incompatible legacy configuration with actionable errors; do not silently ignore `autoMerge: true`. Temporarily preserve/report maintenance needing the replacement path rather than invoking unsafe legacy behavior.

Extend existing actual-Git/process fixtures with stateful service substitutes, an independent observer, request/acceptance ledgers, controlled clocks and crash barriers. Start with one complete passing/draft publication path, accepted-but-unacknowledged PR creation, and human terminal events. Record which current assertions conflict with requirements and change them deliberately alongside their behavior fixes.

**Completion / acceptance:** No reachable orchestrator action automatically merges or force-pushes. Published commits remain unchanged in guardrail tests. The harness detects duplicate external effects and transient forbidden actions rather than merely checking final mocked calls. A baseline records existing failures and unexecuted obligations honestly; unresolved defects are not approved by passing old tests.

**Verification:** REQ-PR-008 AC1; REQ-GIT-001 AC3; REQ-MNT-002 AC1/AC3; REQ-TST-001–003. Start VER-PR-008-01, VER-GIT-001-01, VER-MNT-002-01, VER-TST-001-01, VER-TST-002-01 and VER-TST-003-01. Full behavioral closure follows in the phases assigned below. Addresses F1, F3, F4 and F13.

### P2 — Make project ownership and attempt persistence authoritative

**Scope:** Implement canonical integration ownership independent of aliases/runtime roots, pinned active integrations/list mappings/storage, and a shared host-visible namespace validated for local/container deployments. Build on atomic/revision-checked records; introduce attempt-specific identity and provenance. Inventory and import legacy task/queue/plan/feedback/maintenance/commit/block records without losing references. Establish allowed transitions, pending operation records, wait checkpoints, recoverable registry handoffs and migration versions. Replace crash-stranded plain locks with evidence-based ownership recovery.

Keep startup configuration strict, loaded once, with at least one project; reject active removal/rename/redirection/relocation. Keep confirmed invalid startup resources from partially executing tasks; unavailable project resources remain explicit and do not become assumed validity. Support the required optional commands/models and defaults as their consuming phases land, not speculative options. Add Git/OpenCode/gh compatibility checks for enabled capabilities only.

**Completion / acceptance:** Competing aliases/roots and local/container processes cannot both execute the same canonical project. Active ownership survives restart and unsupported migrations preserve originals. All imported phases either map deterministically or retain a visible migration blockage; no “missing” record authorizes a new claim. No duplicate writer or dual-written authoritative state exists. Configuration/resource/dependency rejection occurs before affected task execution.

**Verification:** REQ-CFG-001–006, REQ-SCH-001 and REQ-REC-005; VER-CFG-001-01 through VER-CFG-006-01, VER-SCH-001-01 and VER-REC-005-02. Exercise actual local/container contention and interrupted migration; operational shutdown closure is P3/P5. Addresses F5, F8 and cross-cutting state authority.

### P3 — Unify safe execution, diagnostics and secret boundaries

**Scope:** Extend existing process-group cancellation/timeouts to every child-process family, including Git/gh/clone. Use operation-specific environment allowlists, protected credential sources and consistent known-secret/recognized-encoding redaction on controlled inputs/outputs. Capture all process streams separately; structured events carry typed sanitized summaries and log references, never raw error text. Store task-organized history and process artifacts at pinned external runtime paths. Default retention to 30 days and protect durable active tasks, including idle Human Review and restarted attempts; remove immediate completion-log deletion.

**Completion / acceptance:** Shutdown stops claims and cancels owned process trees safely. Every execution has traceable start/result/interruption evidence. Canary and environment checks cover declared channels/forms; no universal unknown-secret claim is made. Active evidence survives retention/restart. Models/credential selection remain project-isolated; App/PAT behavior is preserved.

**Verification:** REQ-LOG-001–003, REQ-SEC-001–003, REQ-REC-005 AC1 and REQ-REC-006 AC1; VER-LOG-001-01 through VER-LOG-003-01, VER-SEC-001-01 through VER-SEC-003-01, VER-REC-005-01 and VER-REC-006-01. Repeat channel checks as later external payloads are wired. Addresses F5 and F12.

### P4 — Journal and reconcile external mutations

**Scope:** Introduce the mutation vocabulary described above, using concrete Trello/GitHub/Git reconciliation. First persist initial publication intent and actual PR identity before Trello synchronization. Then route moves, comments, replies, PR body/draft/status changes and cleanup intents through it. Verify intended destination/fields, not only response shape. Carry preserved completed effects across subsequent failure.

Add the notification delivery record/outbox using the same intent/outcome distinctions, without making email a workflow prerequisite. Preserve four event types, task/project links, explicit actual draft status and outstanding issues; event identity is not a pre-send delivery claim. Retry known non-delivery; reconcile or report ambiguous transport acceptance.

**Completion / acceptance:** Crash barriers cover intent, dispatch, acceptance, response and durable completion. PR creation followed by Trello failure resumes the original PR. Late acceptance after negative lookup never causes blind non-idempotent resend. Pending workflow uncertainty blocks the next task with controlled rechecks; email uncertainty does not undo publication or prevent terminal release. Every mutation has a declared repeatability/discovery policy.

**Verification:** REQ-WF-001, REQ-PR-005–006, REQ-NOT-001–002 and shared transition criteria; VER-WF-001-01/02/03, VER-PR-005-01, VER-PR-006-01, VER-NOT-001-01 and VER-NOT-002-01. Workflow-specific field/race variants close in P7/P9/P10. Addresses F6 and F11, with F7/F10 mutation foundations.

### P5 — Recover execution, setup and primary context safely

**Scope:** Replace absorbing attention blocks with typed recoverable checkpoints, bounded immediate attempts, paced dependency rechecks and deduplicated attention. Reconcile stale ownership/process/session evidence; use monitoring as a last-resort safety net rather than normal progress. Distinguish primary crash, advisory failure, outage, unexpected manual card move and genuine unrecoverability before/after publication.

Reuse original primary sessions first. Confirm loss before replacement, preserve old references, and reconstruct task/repository/plan/attachment/change/history/feedback context before continuing. Refresh attachments for every resumed primary activity, including CI work. Respect per-activity optional model/variant settings and OpenCode defaults; report explicit unavailable selections without substitution.

Run configured setup before both refinement and implementation, persist independently attributed before/after effects, skip previously verified setup when safe, and preserve unrelated setup changes. The agent supplies task-relevance judgments; unsafe attribution prevents committing unrelated changes. Add evidence-based unclear-task outcomes after examining available context.

**Completion / acceptance:** A restored essential dependency resumes the verified checkpoint automatically. A returned manually moved card resumes only after safety checks. Primary recovery uses existing operation retries; pre-PR genuine failure preserves work and finalizes `Failed`, while open-PR correction failure retains ownership and an explicit blockage. Individual operations time out; long progressing tasks have no overall deadline. Setup failures never start the agent. Context reconstruction is complete enough to verify or remains blocked.

**Verification:** REQ-WF-002–003, REQ-PR-003, REQ-REC-001–006, REQ-IMP-002/004, REQ-ENV-002–003 and REQ-CTX-001/002/004. VER-WF-002-01/02, VER-WF-003-01, VER-PR-003-01/02/03, VER-REC-001-01 through VER-REC-006-02 (existing scenario IDs only), VER-IMP-002-01, VER-IMP-004-01/02, VER-ENV-002-01, VER-ENV-003-01, VER-CTX-001-01, VER-CTX-002-01 and VER-CTX-004-01. Addresses F5, F7–F9; A2/A5 edge oracles require agreement below.

### P6 — Make initial implementation and publication consistently advisory

**Execution boundary:** [P6 packet](p6-execution.md). Initial-description and clarification-failure contributions are owned here; feedback/CI/maintenance refresh and clean clarified requeue remain with P7/P8/P10. Prove the selected source-checkout protection capability before depending on it.

**Scope:** Replace mandatory approved plans and quality gates in schemas, prompts and initial execution with one evidence/reporting policy. Attempt planning and independent review before implementation; allow the agent to adapt/disregard advice and proceed after bounded advisory failure. Validation/coverage are independently optional; missing commands are skipped. Keep separate configurable validation/review improvement maxima, persist counters and stop on early finish or no-change.

Retain source/content checks and commit-intent recovery. Produce one initial descriptive generated commit from meaningful task-relevant changes, including only appropriately attributed setup changes. A no-meaningful-output or essential-clarification outcome is explained and verified as failure, never an artificial PR. Keep original checkout protection enforceable through scoped OpenCode permissions and execution boundaries, with actual negative tests rather than cwd/prompt assertions alone.

Create normal/draft PRs using observed results and material-issue dispositions, not reviewer approval. Maintain accurate descriptions with complete deterministic fallback and issue/check disclosure, persist the PR before remaining effects, then verify `Human Review`. Provide safe draft-to-ready updates when evidence supports them. Connect publication/failure/attention events to P4 delivery.

**Completion / acceptance:** Adverse, unavailable, malformed, exhausted and crashed advisory stages all permit safe meaningful delivery; no-op does not repeat unchanged reviews. Primary unrecoverability retains its separate exception. Unconfigured commands are never claimed as passed. Readiness is honest and source/scope/credential safety remains mandatory. Human merge remains the sole merge action.

**Verification:** REQ-PR-001–004/007, REQ-IMP-001/003/005, REQ-VAL-001–005 and REQ-CTX-002–003. VER-PR-001-01 through VER-PR-004-01 (all defined variants), VER-PR-007-01, VER-IMP-001-01, VER-IMP-003-01, VER-IMP-005-01, VER-VAL-001-01 through VER-VAL-005-01, VER-CTX-002-01 and VER-CTX-003-01. Run the adverse-quality complete simulated path and begin realistic publication evidence. Addresses F1–F2, F4, F9–F12.

### P7 — Coordinate active-PR observation and human feedback

**Execution boundary:** [P7 packet](p7-execution.md). Own observation, queue/capacity behavior, feedback correction, and terminal fencing; P8 owns maintenance execution and P10 owns final artifact cleanup/fresh retry. Queue ordering may use production queue descriptors before maintenance execution exists.

**Scope:** Split observation from mutation execution while retaining one project writer. Persist new feedback/CI/terminal observations during AI execution. Implement queue priorities and prerequisites, a durable FCFS global AI slot queue with an optional cap, and current Trello eligibility/order at claims. Use one optional polling interval defaulting to 15 seconds and controlled backoff. Human Review releases AI capacity but retains the active task.

Refresh all feedback sources and actor identities. Separate current actionable requests from immutable handling history; ask OpenCode for evidence-backed actionability/substantive-change judgments rather than embedding semantic judgment in deterministic orchestration. Exclude bot/status/self replies; retire deleted/superseded requests. Bound automated work per round while permitting unlimited genuinely new human rounds.

Move `Human Review` to verified `Working` during remediation, reuse the primary session, publish available additive corrections despite adverse quality, report fixed/unresolved/uncertain dispositions honestly, retain draft for unresolved requests and never resolve threads automatically. Wire managed description/activity updates throughout. A verified merge/closure supersedes active/queued work, invalidates stale completions, safely cancels execution and reconciles dispatched effects before terminal handoff to P10.

**Completion / acceptance:** Feedback arriving during execution is retained without competing writers. Unchanged/cosmetic/exhausted feedback does not restart remediation. Human requests precede CI/maintenance; required prerequisites are explicit. Capacity is fair and excludes human waits. Terminal races at edit/push/acceptance/restart boundaries cannot schedule a new push or restore Human Review after verified closure; late dispatched effects remain explicit until reconciled.

**Verification:** REQ-HR-001–006, REQ-PR-007–008, REQ-TR-004, REQ-SCH-001–004 and REQ-MNT-004. VER-HR-001-01 through VER-HR-006-01, VER-PR-007-01, VER-PR-008-01/02, VER-TR-004-01, VER-SCH-001-01 through VER-SCH-004-01 and VER-MNT-004-01. Include real Git remote-deletion races and actor/feedback API evidence. Addresses F3, F8–F10; safe cleanup/retry closure is P10.

### P8 — Bound CI episodes and restore additive PR maintenance

**Execution boundary:** [P8 packet](p8-execution.md). Resolve expected-check and episode-trigger oracles before dependent tasks. Carry setup exclusions and unshipped changes through additive maintenance; do not assume a fully clean worktree when preserved work is expected.

**Scope:** Retain conservative expected-check/current-revision evidence, adding durable observation deadlines and uncertain-result disclosure. Implement separate configurable CI correction maxima and initiating-event episode identities independent of SHA. Repeated polls, generated fixes and routine target merges cannot renew exhausted budgets. No-op/early finish ends the episode; newly verified human requests or independent materially new failures can start another.

Replace published rebase/force-with-lease with target-branch merge and ordinary fast-forward-safe push to the same PR. Preserve published commit objects, unrelated remote changes, conflicts and unshipped work. Use the agent for conflict resolution with bounded execution and advisory follow-up. Detect maintenance automatically, including approved-open PRs, and remove legacy opt-in policy that suppresses required behavior. Preserve PR activity/description updates and terminal checks at safe mutation boundaries.

**Completion / acceptance:** Missing/pending checks leave Working at the recorded bound with honest uncertainty. Exhausted CI remains draft without looping or resetting its budget on new self-generated SHAs. Available CI/maintenance corrections publish despite negative advice. Divergent published branches gain additive merge history without force-push, replacement PR, silent discard or stale terminal completion. Temporarily deferred P1 maintenance can now safely resume.

**Verification:** REQ-CI-001–002, REQ-MNT-001–004 and REQ-GIT-001–002. VER-CI-001-01, VER-CI-002-01, VER-MNT-001-01 through VER-MNT-004-01, VER-GIT-001-01, VER-GIT-002-01 and shared VER-PR-008-02. Verify actual remote commit ancestry as well as recorded policy. Addresses F1–F4 and F10.

### P9 — Make refinement recoverable and demonstrably read-only

**Execution boundary:** [P9 packet](p9-execution.md). Demonstrate the needed Trello Free history capabilities and read-only boundary first; migrate P5 result-file/baseline handling explicitly. Successful verified refinement release is owned here; historical cleanup/fresh retry is owned by P10.

**Scope:** Move refinement onto durable attempts, P5 setup/context and P4 mutation reconciliation. Keep strict full-result validation and distinct templates, adding bounded correction of invalid results. Store result artifacts outside the worktree and enforce read-only agent access. Compare repository content/HEAD/refs and ignored/untracked effects against the post-setup baseline; a clean `git status` alone is insufficient evidence.

Persist original/intended card fields before writes; compare current fields, track verified writes and inspect available postwrite change history. On partial acceptance complete or safely compensate only when attributable. Preserve human values and pause on conflicting/unattributable edits, including edits between final read and write. Verify complete fields, Backlog transition and concise type/duration comment without duplicating description. Keep scope/grounding judgment with the agent and approved human rubrics; never automatically split/create cards.

**Completion / acceptance:** Interrupted refinement resumes or reaches a safely verified restored/failure outcome, never a partial final result claimed as completion. Human-edit uncertainty retains ownership and pending reconciliation rather than blind rollback. Setup changes are separate from agent changes; the refinement agent changes no repository content. Successful verified Backlog releases the active attempt.

**Verification:** REQ-REF-001–005, REQ-ENV-002 and REQ-CTX-001/003. VER-REF-001-01 through VER-REF-005-01 (including VER-REF-004-02 read/write races), VER-ENV-002-01, VER-CTX-001-01 and VER-CTX-003-01. Require realistic history/read-only/grounding evidence, not just a validated JSON result. Addresses F7 and F9; A2 rubric decisions remain explicit.

### P10 — Finish terminal reconciliation, artifact safety and deliberate retry

**Execution boundary:** [P10 packet](p10-execution.md). Freeze the supported upgrade cohort and terminal/resource handoff matrix before implementation. Reuse earlier terminal-fencing evidence; add final synchronization, preservation, cleanup, archival, and retry composition.

**Scope:** Compose terminal precedence with verified Done/closed-Backlog/Failed/refinement-Backlog outcomes, explanatory outcome comments and appropriate non-blocking notifications. Verify all required workflow effects before releasing the active-task claim; retain unresolved in-flight mutations. Distinguish workflow reconciliation from cleanup safely deferred with preserved artifacts.

Strengthen cleanup provenance with common Git directory, attempt manifest, expected refs and proof that local work is preserved. Check clean local-only commits as well as dirty files. Treat already-absent owned resources and GitHub-deleted remote branches idempotently. For unmerged closure verify implementation accessibility through the closed PR before local removal. Preserve unsafe/unshipped artifacts and diagnostics instead of deleting to unblock progress.

Archive reconciled old attempt identities and create fresh attempt-specific branches/worktrees/sessions from latest accepted default branch only after explicit requeue. Preserve prior unfinished code separately; never reuse it automatically or let known archived resources trap a new attempt. Closed PRs are optional historical context, not approved implementation. Pending cleanup can remain attached to the archived attempt only after noninterference and preservation are verified; unknown ownership or in-flight effects still block release.

**Completion / acceptance:** Merge produces verified Done; unmerged closure verified Backlog; genuine pre-PR failure verified Failed with explanation and preserved work. Next-task selection is impossible before required reconciliation. Cleanup replay tolerates prior success, refuses unsafe deletion and preserves unshipped work after terminal races. Explicit failed/closed requeue succeeds cleanly without internal-file edits or old-code inheritance. Logs remain subject to P3 retention rather than task-completion deletion.

**Verification:** REQ-TR-001–003, REQ-GIT-003–006, REQ-SCH-001 and terminal portions of REQ-PR-008/REQ-REF-005. VER-TR-001-01 through VER-TR-003-01, VER-GIT-003-01 through VER-GIT-006-01, VER-SCH-001-01, VER-PR-008-02 and VER-REF-005-01. Repeat VER-NOT-001-01 and VER-NOT-002-01 for all final event routes. Addresses F3–F7, F11–F12.

### P11 — Establish complete lifecycle evidence and close the release transition

**Execution boundary:** [P11 packet](p11-execution.md). Freeze and resource the finite release qualification matrix before execution. Earlier-phase decision prerequisites must already be resolved; only explicitly registered residual decisions may remain for P11.

**Scope:** Complete simulated application-boundary lifecycle/fault matrices and realistic disposable Trello Free/GitHub/OpenCode/email runs locally and in Docker-compatible deployment. Use actual prior/current application artifacts for upgrade tests. On this host, record Podman when used for the container run. Add only deployment artifacts required for supported parity, not permanent live-test infrastructure.

Consolidate per-criterion/variant evidence and resolve only the A2/A5 decisions explicitly assigned to release qualification in the readiness register; do not postpone earlier implementation prerequisites to this phase. Retire legacy workflow dispatch, redundant mutable state and compatibility paths only after supported active records have migrated or drained. Update future operator/configuration/recovery guidance to describe supported transitions rather than manual file repair. Preserve historical fixtures and evidence for supported upgrade versions.

**Completion / acceptance:** Every requirement/criterion has an assessable demonstrated outcome at required levels; missing realistic evidence cannot be substituted by unit success. The supported upgrade/local/container matrix passes, including ownership and volume identity, process interruption, secret channels and complete human outcomes. No legacy route can reactivate contradictory behavior. Final completion is subject to the criteria below.

**Verification:** REQ-ENV-001 and REQ-TST-001–003, with all prior requirement scenarios composed through VER-ENV-001-01, VER-TST-001-01/02, VER-TST-002-01 and VER-TST-003-01; repeat VER-REC-005-02 using release artifacts. Addresses F13 and remaining evidence qualifications across F1–F12.

## Migration and compatibility strategy

### Incremental deployment and active workflow handoff

1. **Inventory before each rollout.** Record running versions, canonical project identities, active cards/attempts, expected lists, sessions, worktrees/common repositories, local/remote heads, PR identities, queued operations and uncertain writes. Preserve sanitized diagnostic references; do not contact production with destructive migration probes.
2. **Quiesce the outgoing writer.** Stop claims, checkpoint/interrupt owned operations safely and retain artifacts. Never run old and new workers concurrently for the same project. A read-only comparison can inspect copied fixtures; shadow code must not dispatch side effects or write live authority.
3. **Establish common ownership before new claims.** Existing versions do not understand the new namespace. Stop those processes and confirm deployment mounts/configuration before enabling the new owner; a new lease cannot retroactively fence old binaries. Operators must use the common host namespace. Detectable missing/incompatible setup fails safely; independently hidden namespaces cannot be reliably discovered without a shared coordination contract. Validate the deployment convention with actual contention tests before rollout.
4. **Import with originals retained.** At the pinned storage location, snapshot legacy records and referenced artifacts, validate all inputs, produce a versioned candidate and verify its provenance/references. Commit a recoverable handoff marker/pointer only when complete. Restarting an interrupted import repeats local verification, not external mutations. Unsupported, conflicting or malformed records remain intact and isolate the affected project.
5. **Resume from verified evidence.** Preserve session IDs, worktree paths, commits, PR identities, budgets, feedback history and prior completed operations. Legacy data lacking proof receives an explicit reconciliation checkpoint; do not invent an intent or an original card snapshot after the fact. Discover a PR by verified repository/head/base/attempt evidence before binding it. A negative read during uncertainty never means the old write can be resent.
6. **Deploy by project and workflow boundary.** Start with disposable fixtures, then a small agreed project cohort, expanding after phase checks and recovery observations. New-attempt-only behavior can wait for current attempts to finish; never wait for all Human Review PRs to close merely to ship a compatible release. Existing open PRs need supported import/resumption or an explicit preserved blockage. Restart is the only configuration activation boundary.
7. **Retain compatible readers until supported attempts drain.** Each release states readable/writable schema versions and migration directions. One authoritative writer is selected per imported attempt; avoid dual writes to legacy and new stores. Copy derived exports only if needed for inspection, never for competing decisions. Retire compatibility after recorded supported-version evidence, not simply after a calendar interval.

### Artifact-specific compatibility rules

| Existing state                                                        | Safe migration behavior                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active Working task with primary session and dirty worktree           | Preserve exactly; verify owner/process/session/Git/Trello checkpoint before reconnecting. No fresh attempt, automatic commit, reset or draft publication of interrupted primary work.                                                                                                                                       |
| Idle Human Review PR or active correction                             | Pin original PR and published commits; retain occupancy. Import feedback and pending work, apply terminal precedence, resume additive corrections only when safe.                                                                                                                                                           |
| Prepared legacy rebase/force-push maintenance                         | Do not dispatch the legacy push. Preserve backup refs, rewritten local objects, published remote history and any unshipped edits. Reconcile remote acceptance first; prepare additive work from verified published history without resetting/discarding the old worktree. Human review may be needed for ambiguous history. |
| Legacy PR exists but task record lacks identity                       | Preserve discovery evidence and pending publication; bind only after verified provenance. No replacement PR or new task while association is uncertain.                                                                                                                                                                     |
| Interrupted refinement lacking original fields or trustworthy history | Preserve actual fields and recoverable history; do not fabricate originals or claim rollback. Pause for explicit reconciliation/operator agreement.                                                                                                                                                                         |
| Setup changes mixed with implementation                               | Retain current tree and available execution/diff history. Ask the agent to establish task relevance; unknown attribution blocks unsafe inclusion rather than silently staging all or deleting files.                                                                                                                        |
| Stale lock, orphan process, inaccessible OpenCode session             | Verify host/container owner and process identity; do not use age/PID alone to steal ownership. Reconnect before reconstructing; unknown state is observable waiting.                                                                                                                                                        |
| Failed or closed historical attempt                                   | Archive intact after reconciliation. Explicit requeue creates clean new resources and current context; historical code is not carried forward automatically.                                                                                                                                                                |
| Active configuration rename/removal/integration/path change           | Reject/defer until verified terminal outcome. Compatible operational settings apply on restart; schema migration at the pinned path does not authorize relocation.                                                                                                                                                          |

### Release and rollback policy

Ship each phase or coherent sub-deliverable once its checks pass and its affected persisted states have a supported handoff. Temporary internal adapters may route an imported attempt to the supported implementation; do not expose a permanent legacy/new-engine configuration choice. Partial releases must list remaining requirement gaps, deferred maintenance and recovery limits. They must not claim architectural completion.

Rollback means stopping claims/mutations, preserving current evidence and selecting a release that can read the current state and honors the safety invariants. If the previous binary cannot, prefer a forward fix or a local, validated reverse migration while quiesced. Restoring an old snapshot is safe only when no later externally accepted effect or local work would be forgotten; reconcile current PRs/refs/cards and operation outcomes first. Never roll back external Git history, reopen/recreate closed PR work, resend uncertain comments, or redeploy known auto-merge/force-push routes as a recovery shortcut.

## Risk register

| Risk / highest-impact phases                                                                              | Mitigation and detection                                                                                                                    | Rollback or recovery                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1: Split ownership across aliases, roots, containers or old binaries (P2, rollout)                       | Common canonical registry, actual process contention tests and explicit old-writer shutdown; validate host-visible mount/namespace.         | Stop new claims; preserve both records and inspect effects. Resume one verified owner only; never resolve by deleting unknown locks.                                                                         |
| R2: State consolidation or migration loses progress/references (P2, P11)                                  | Versioned originals, candidate validation, interrupted-handoff tests, cross-store inventory and actual prior-version fixtures.              | Keep affected project blocked with original evidence; use compatible reader or forward repair. Never revert state past accepted effects.                                                                     |
| R3: Timeout/negative read duplicates a late accepted mutation (P4, P9)                                    | Intent before dispatch; independent effect ledgers; uncertainty states and controlled discovery; no unsupported exactly-once promise.       | Retain ownership and pending intent; reconcile provider/history evidence or request operator outcome resolution.                                                                                             |
| R4: Human merge/closure races a push or stale completion (P7–P10)                                         | Continuing observation, local generation fencing, authoritative checks at boundaries, safe cancellation, in-flight effect reconciliation.   | Preserve unshipped work; terminal outcome wins. No new push or branch recreation; a dispatched write's late result must be reconciled before release. Remote APIs cannot guarantee an atomic check-and-push. |
| R5: Removing quality gates accidentally publishes crashed primary work or unrelated setup changes (P5–P6) | Typed primary/advisory/setup outcomes, task-relevance evidence, separate safety checks and actual crash/quality contrast tests.             | Stop unsafe publication with preserved work; bounded recovery or verified pre-PR failure. Quality-only failure still follows draft delivery.                                                                 |
| R6: Retry/CI identity resets cause infinite work (P5, P7–P8)                                              | Durable per-policy counters, initiating-event identities, before/after content evidence and unchanged-poll observation.                     | End exhausted episode with honest draft/reporting; preserve essential waits with controlled rechecks. No global task timeout.                                                                                |
| R7: Cleanup or fresh retry loses clean-but-unshipped commits (P10)                                        | Provenance/common-repository checks, reachability/preservation evidence, separate attempt resources and dirty/local-only negative controls. | Preserve/quarantine owned artifacts without destructive reset. Reconcile old attempt before creating clean retry resources.                                                                                  |
| R8: Refinement compensates over a human edit (P9)                                                         | Original/intended/verified/human snapshots, prewrite comparisons and postwrite history; realistic read/write race tests.                    | Pause writes, preserve recoverable content and request explicit reconciliation. No atomic Trello rollback claim.                                                                                             |
| R9: Secrets or raw diagnostics cross a new shared boundary (P3–P11)                                       | Least-privilege inputs, known-form redaction and per-channel canary tests, including failure/recovery payloads.                             | Stop the affected output path, retain protected diagnostics and fix the boundary before resumption; evidence names checked forms without claiming universal detection.                                       |
| R10: Reporting/notification failure hides successful publication (P4, P6–P8)                              | Persist PR first, complete deterministic evidence fallback, durable public-update obligations and separate delivery records.                | Retry safe reporting reconciliation on the same PR. Keep email uncertainty non-blocking; never repeat publication because notification failed.                                                               |
| R11: Passing mocks conceal provider/environment incompatibility (P1, P11)                                 | Real Git/processes, stateful substitutes, independent observers and realistic Free-plan/App/PAT/session/local/container runs.               | Record partial/blocked evidence and keep affected rollout paused; repair narrowly. Permanent live infrastructure is not required.                                                                            |

## Traceability

### Requirement and acceptance-criterion coverage

The following 82 rows identify a **domain integration owner** and supporting phases, not permission to require later-phase behavior at an earlier delivery gate. The linked scenarios retain all acceptance criteria and evidence levels; their `Coverage` fields supply the exact AC mapping. P6–P11 packets partition the applicable workflow variants, and P11 verifies final cross-domain qualification. A contribution pass never closes an entire requirement whose later variants or required levels are unexecuted. No criterion is waived by this delivery partition. Historical P1–P5 evidence remains historical and does not retroactively become full acceptance.

This is planned coverage. The audit baseline is 2 Implemented, 51 Partial, 3 Missing, 25 Contradictory and 1 Unverified. Even the two Implemented requirements require regression evidence through migration. Execution records must retain per-AC status, evidence and missing levels, following VER-TST-003-01; this table does not upgrade any implementation status.

| Requirement | Domain integration owner (support) | Verification scenarios                      |
| ----------- | ---------------------------------- | ------------------------------------------- |
| REQ-WF-001  | P4 (P7, P9, P10)                   | VER-WF-001-01, VER-WF-001-02, VER-WF-001-03 |
| REQ-WF-002  | P5 (P2, P10)                       | VER-WF-002-01, VER-WF-002-02                |
| REQ-WF-003  | P7 (P5)                            | VER-WF-003-01                               |
| REQ-PR-001  | P6 (P7, P8)                        | VER-PR-001-01                               |
| REQ-PR-002  | P6 (P8)                            | VER-PR-002-01                               |
| REQ-PR-003  | P7 (P5, P6)                        | VER-PR-003-01, VER-PR-003-02, VER-PR-003-03 |
| REQ-PR-004  | P6 (P4)                            | VER-PR-004-01                               |
| REQ-PR-005  | P4 (P6)                            | VER-PR-005-01                               |
| REQ-PR-006  | P5 (P4, P6)                        | VER-PR-006-01                               |
| REQ-PR-007  | P8 (P6, P7)                        | VER-PR-007-01                               |
| REQ-PR-008  | P10 (P1, P7)                       | VER-PR-008-01, VER-PR-008-02                |
| REQ-TR-001  | P10 (P4, P7)                       | VER-TR-001-01                               |
| REQ-TR-002  | P10 (P4, P7)                       | VER-TR-002-01                               |
| REQ-TR-003  | P10 (P4, P5, P6)                   | VER-TR-003-01                               |
| REQ-TR-004  | P7 (P2)                            | VER-TR-004-01                               |
| REQ-REF-001 | P9 (P3, P5)                        | VER-REF-001-01                              |
| REQ-REF-002 | P9                                 | VER-REF-002-01                              |
| REQ-REF-003 | P9                                 | VER-REF-003-01                              |
| REQ-REF-004 | P9 (P4)                            | VER-REF-004-01, VER-REF-004-02              |
| REQ-REF-005 | P9 (P4, P10)                       | VER-REF-005-01                              |
| REQ-IMP-001 | P6 (P2, P3)                        | VER-IMP-001-01                              |
| REQ-IMP-002 | P5 (P6)                            | VER-IMP-002-01                              |
| REQ-IMP-003 | P6 (P5)                            | VER-IMP-003-01                              |
| REQ-IMP-004 | P8 (P5, P7)                        | VER-IMP-004-01, VER-IMP-004-02              |
| REQ-IMP-005 | P6 (P10)                           | VER-IMP-005-01                              |
| REQ-VAL-001 | P6                                 | VER-VAL-001-01                              |
| REQ-VAL-002 | P6 (P7, P8)                        | VER-VAL-002-01                              |
| REQ-VAL-003 | P6 (P2)                            | VER-VAL-003-01                              |
| REQ-VAL-004 | P6 (P5, P7, P8)                    | VER-VAL-004-01                              |
| REQ-VAL-005 | P6 (P7, P8)                        | VER-VAL-005-01                              |
| REQ-HR-001  | P7                                 | VER-HR-001-01                               |
| REQ-HR-002  | P7 (P6)                            | VER-HR-002-01                               |
| REQ-HR-003  | P7                                 | VER-HR-003-01                               |
| REQ-HR-004  | P7 (P4, P6)                        | VER-HR-004-01                               |
| REQ-HR-005  | P7 (P6)                            | VER-HR-005-01                               |
| REQ-HR-006  | P7 (P8, P10)                       | VER-HR-006-01, VER-PR-008-02                |
| REQ-CI-001  | P8                                 | VER-CI-001-01                               |
| REQ-CI-002  | P8 (P6, P7)                        | VER-CI-002-01                               |
| REQ-MNT-001 | P8 (P7)                            | VER-MNT-001-01                              |
| REQ-MNT-002 | P8 (P1)                            | VER-MNT-002-01                              |
| REQ-MNT-003 | P8 (P6)                            | VER-MNT-003-01                              |
| REQ-MNT-004 | P8 (P7)                            | VER-MNT-004-01                              |
| REQ-REC-001 | P5 (P2, P4, P11)                   | VER-REC-001-01                              |
| REQ-REC-002 | P7 (P5)                            | VER-REC-002-01, VER-PR-003-03               |
| REQ-REC-003 | P5 (P4)                            | VER-REC-003-01                              |
| REQ-REC-004 | P5 (P2, P10)                       | VER-REC-004-01                              |
| REQ-REC-005 | P11 (P2, P3, P5)                   | VER-REC-005-01, VER-REC-005-02              |
| REQ-REC-006 | P5 (P3)                            | VER-REC-006-01, VER-REC-006-02              |
| REQ-GIT-001 | P8 (P1, P6, P10)                   | VER-GIT-001-01                              |
| REQ-GIT-002 | P8 (P6)                            | VER-GIT-002-01                              |
| REQ-GIT-003 | P10 (P2)                           | VER-GIT-003-01                              |
| REQ-GIT-004 | P10                                | VER-GIT-004-01                              |
| REQ-GIT-005 | P10                                | VER-GIT-005-01                              |
| REQ-GIT-006 | P10 (P2)                           | VER-GIT-006-01                              |
| REQ-CFG-001 | P2                                 | VER-CFG-001-01                              |
| REQ-CFG-002 | P11 (P2, P5)                       | VER-CFG-002-01                              |
| REQ-CFG-003 | P2 (P11)                           | VER-CFG-003-01                              |
| REQ-CFG-004 | P2 (P5)                            | VER-CFG-004-01                              |
| REQ-CFG-005 | P2 (P3, P11)                       | VER-CFG-005-01, VER-CFG-004-01              |
| REQ-CFG-006 | P2                                 | VER-CFG-006-01                              |
| REQ-SCH-001 | P10 (P2, P7, P9)                   | VER-SCH-001-01, VER-PR-003-03               |
| REQ-SCH-002 | P7                                 | VER-SCH-002-01                              |
| REQ-SCH-003 | P7                                 | VER-SCH-003-01                              |
| REQ-SCH-004 | P7                                 | VER-SCH-004-01                              |
| REQ-LOG-001 | P3 (P4–P10)                        | VER-LOG-001-01                              |
| REQ-LOG-002 | P3 (P4–P10)                        | VER-LOG-002-01                              |
| REQ-LOG-003 | P3 (P10)                           | VER-LOG-003-01                              |
| REQ-NOT-001 | P10 (P4, P6, P9)                   | VER-NOT-001-01                              |
| REQ-NOT-002 | P4 (P10)                           | VER-NOT-002-01                              |
| REQ-SEC-001 | P3 (P11)                           | VER-SEC-001-01                              |
| REQ-SEC-002 | P3 (P4–P11)                        | VER-SEC-002-01                              |
| REQ-SEC-003 | P11 (P3)                           | VER-SEC-003-01                              |
| REQ-ENV-001 | P11 (P2, P3)                       | VER-ENV-001-01                              |
| REQ-ENV-002 | P9 (P5, P6)                        | VER-ENV-002-01                              |
| REQ-ENV-003 | P5                                 | VER-ENV-003-01                              |
| REQ-CTX-001 | P9 (P5, P7, P8)                    | VER-CTX-001-01                              |
| REQ-CTX-002 | P10 (P5, P6)                       | VER-CTX-002-01                              |
| REQ-CTX-003 | P9 (P3, P6–P8)                     | VER-CTX-003-01                              |
| REQ-CTX-004 | P5 (P7)                            | VER-CTX-004-01                              |
| REQ-TST-001 | P11 (P1–P10)                       | VER-TST-001-01, VER-TST-001-02              |
| REQ-TST-002 | P11 (P1–P10)                       | VER-TST-002-01                              |
| REQ-TST-003 | P11 (P1–P10)                       | VER-TST-003-01                              |

### Significant audit-finding coverage

Finding links retain the audit's evidence and criterion-level gap assessment; their presence here is not a claim that those gaps have been fixed.

| Finding                                                                                                                       | Plan response and closure evidence                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [F1: Quality policy and publication](implementation-audit.md#f1-quality-policy-and-publication)                               | P6 replaces schema/prompt/caller approval gates and evidence/readiness drift; P7/P8 apply the same policy to feedback, CI and maintenance. Adverse complete lifecycle evidence in P11.                                            |
| [F2: Remediation bounds and CI episodes](implementation-audit.md#f2-remediation-bounds-and-ci-episodes)                       | P6 separate maxima and early/no-op stops; P8 durable CI deadline and initiating-event budgets across SHAs/restarts.                                                                                                               |
| [F3: Human PR outcomes and terminal races](implementation-audit.md#f3-human-pr-outcomes-and-terminal-races)                   | P1 removes merge automation; P7 observes/cancels/fences stale work; P10 verifies terminal effects and release, including missing/manual card state.                                                                               |
| [F4: Git isolation, history, cleanup and retries](implementation-audit.md#f4-git-isolation-history-cleanup-and-clean-retries) | P1 blocks rewriting; P2 records provenance; P6 scopes changes/initial commit; P8 merges additively; P10 proves preservation before cleanup and fresh retry.                                                                       |
| [F5: Persistence, recovery and liveness](implementation-audit.md#f5-persistence-recovery-and-operation-liveness)              | P2 unifies state/locks/upgrades; P3 process interruption; P5 resumes/reconstructs with bounded explicit outcomes rather than absorbing attention. P11 tests real artifacts.                                                       |
| [F6: External mutations and partial publication](implementation-audit.md#f6-external-mutations-and-partial-publication)       | P4 persists intents/PR identity, verifies effects and handles late acceptance; P9/P10 compose card and terminal obligations.                                                                                                      |
| [F7: Refinement and setup](implementation-audit.md#f7-refinement-and-setup)                                                   | P5 attributes setup and prevents unsafe agent start; P6 reviews setup diff disposition; P9 validates/corrects read-only refinement and reconciles partial/human-conflicting updates.                                              |
| [F8: Configuration, ownership and scheduling](implementation-audit.md#f8-configuration-ownership-and-scheduling)              | P2 canonical exclusion, pinned identity/storage and startup checks; P5 optional model defaults; P7 current Ready order, priorities, continuous observation, optional fair capacity and polling default; P8 automatic maintenance. |
| [F9: Task context and human feedback](implementation-audit.md#f9-task-context-and-human-feedback)                             | P5 refreshes/reconstructs context; P7 separates live requests/history, classifies actors/actions/edits, queues arrivals and publishes honest partial corrections. P9/P11 verify real grounding/attachments.                       |
| [F10: PR descriptions and visible activity](implementation-audit.md#f10-pr-descriptions-and-visible-activity)                 | P6 complete evidence fallback and maintained descriptions; P7/P8 wire status in every active-PR route, preserve human content and reconcile conflicting body updates.                                                             |
| [F11: Notifications](implementation-audit.md#f11-notifications)                                                               | P4 durable safe delivery/uncertainty and actual draft/issues; P6/P9/P10 connect all required events without workflow rollback or blocking.                                                                                        |
| [F12: Logging, retention and secrets](implementation-audit.md#f12-logging-retention-and-secret-boundaries)                    | P3 full execution history, raw/structured separation, 30-day active-safe retention and credential/channel boundaries; repeat outbound checks through P11.                                                                         |
| [F13: Verification and environment baseline](implementation-audit.md#f13-verification-and-environment-baseline)               | P1 builds independent stateful oracles; every phase supplies behavioral evidence; P11 establishes realistic complete lifecycle, supported upgrades and local/container parity.                                                    |

Cross-cutting audit observations are covered by P2/P4 state authority and recoverable handoffs; P7 ownership/queue/AI-capacity separation and terminal precedence; P5 bounded resumable recovery and session judgment boundaries; P8/P10 history/provenance/preservation; P3/P6 coordinated internal evidence and public reporting; and P1/P11 honest test oracles and evidence levels. None requires adding a generic orchestration framework.

### Decisions requiring human agreement

These decisions constrain specific phase details, not the established invariants. Do not silently turn a fixture value or a current code path into a new requirement.

The actionable owner, due-before task, current status, and required decision or
capability evidence are in [phase-readiness.md](phase-readiness.md). A technical
unknown first receives a bounded feasibility task; it is not an external blocker
until an actual missing permission, resource, supported capability, or product
decision has been demonstrated. Unrelated ready work continues.

| Decision                                                                        | Needed before                                        | Approved treatment / remaining work                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2: Attachment support/limits, final refinement templates and semantic rubrics  | P6/P7/P9 owned semantic gates; P11 qualification     | [D6-RUBRIC](p6-decisions.md#d6-rubric--representative-p6-acceptance-judgments) approved for P6. Build concrete fixtures and required assessment. Later feedback/template/attachment choices remain with their registered owners; no universal diff threshold or orchestrator semantic heuristic.                     |
| A5: Primary accounting and remaining progress/recheck/CI/manual-move boundaries | Before each dependent task in P6/P7/P8               | [D6-RECOVERY](p6-decisions.md#d6-recovery--counted-unit-and-limit) approves three verified genuine failures per primary operation, separately recording outages and reconstruction. Polling/retention defaults remain as specified. Later edge policies remain explicit; no new crash setting or task-wide deadline. |
| Host coordination convention and supported upgrades                             | Before affected handoff/migration                    | Shared host-visible namespace and local/container exclusion remain required. [D6-UPGRADE](p6-decisions.md#d6-upgrade--supported-cohort) approves deployed-release plus P5 PR #218 compatibility, not every experimental commit. Inventory actual versions/artifacts and preserve unsupported originals.              |
| Realistic-service testing and production rollout                                | Before the applicable owned live gate / each rollout | [D6-LIVE](p6-decisions.md#d6-live--authorized-isolated-p6-verification) authorizes bounded isolated P6 tests using existing accounts/models and disposable Free resources. Resource provisioning/evidence remain pending. Production rollout, purchases and expanded plans are not authorized.                       |

A1 (published merge history), A3 (evidence-based readiness), A4 (setup/refinement separation and recovery) and A6 (ambiguous delivery) already have clarified policies in the verification baseline and are implemented as obligations here, not reopened choices. Human merge control, advisory publication, preservation and no force-push are settled requirements.

## Completion criteria

The rewrite is finished only when:

1. All 82 requirements and all 305 acceptance criteria have traceable implementation and evidence, including mapped variants and required realistic levels. Unexecuted, blocked or partial criteria remain visible and prevent claiming full completion; human-approved requirement changes must first update the authoritative baseline explicitly.
2. No reachable route automatically merges, rewrites published commits, force-pushes, loses unrelated work, resolves human review threads, or gates meaningful safe publication on AI approval, validation or CI success.
3. Each project has one verified owner and one active attempt across local/container deployments, with fair optional global AI capacity and no slot held merely for Human Review. Terminal outcomes and required cross-service effects are verified before the next task.
4. Every operation has explicit bounded success/recovery/failure or observable waiting behavior. Essential outages resume safely; advisory outages skip/report; primary failures follow the pre-/post-publication distinction. Monitoring is a fallback and no task-wide deadline is imposed.
5. Interrupted upgrades/shutdowns, late accepted mutations, manual moves, lost sessions and human terminal races preserve work/identities and recover without duplicate PRs/commits/unsafe resends. Unsupported states retain originals and isolate affected projects.
6. Refinement protects repository and human card content; setup attribution, clean deliberate retries, provenance-aware idempotent cleanup, active-safe retention and non-blocking notification uncertainty are demonstrated.
7. Complete simulated and realistic workflows, including adverse draft delivery, partial human remediation, CI episodes, merge-based maintenance, human merge/closure, refinement and restart/retry, are demonstrated locally and in the supported container environment. Actual prior/current release upgrade evidence exists.
8. Controlled credentials/channels/forms are verified and reported accurately. Structured events, separate redacted process output, current descriptions/activity status and optional notifications report the same observed facts without fabricated passes or unsupported atomic/exactly-once claims.
9. All F1–F13 contradictions, missing mechanisms and significant evidence gaps are reassessed with links to closure evidence. Legacy dispatch/authority that could reinstate conflicting behavior is retired after supported migration; valuable fixtures, provenance and historical diagnostics remain preserved.
10. Repository validation passes, supported deployment/recovery instructions match the new behavior, the A2/A5 and rollout decisions are recorded, and humans have reviewed the resulting evidence and architecture against the authoritative requirements.

This plan defines architectural phases and completion criteria. Individual implementation tasks should follow the approved phases and their dependencies.
