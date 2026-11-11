# Temporary rewrite roadmap

Product authority: [requirements](../requirements.md) and
[specification](../specification.md). This roadmap describes implementation
boundaries and shared design, not additional requirements or evidence gates.
Follow [delivery](phase-execution.md) and [current progress](phase-status.md).
Everything in this folder is temporary and removed at completion.

## Why the work is staged

The original implementation mixed workflow policy, mutable state, recovery and
publication across several routes. Fixing a single helper could leave a caller or
restart path enforcing the old policy. The sequence therefore establishes shared
safety/state/execution mechanisms first, then moves complete workflows onto them.
Retain useful existing clients, guards, stores and tests rather than replacing the
application wholesale. Historical shortcomings explain the sequence; they are not
claims that the current code still has every original defect.

This roadmap preserves scope and design context, not an execution diary. The older
roadmap and removed historical records remain in Git history, including the
integrated baseline `92a8276`. They are available for a specific historical question,
not prerequisite reading or instructions to reopen old acceptance work.

## Shared design to preserve

- The orchestrator owns deterministic workflow, ownership, scheduling, budgets,
  publication and reconciliation. OpenCode owns engineering and semantic judgment.
  Do not encode heuristic product judgments as orchestration rules.
- Keep concrete existing clients/managers and small domain functions. No provider
  framework, generic workflow engine, shared database or speculative configuration.
- One canonical owner and active attempt per project; independent projects can
  progress concurrently. Distinguish task ownership, serialized branch mutation
  and optional global AI execution capacity. An idle open PR retains its project
  without consuming an AI slot.
- Keep authoritative versioned, revision-checked attempt state with pinned integration,
  storage and owner generation. Lifecycle, active operation and wait/recovery are
  distinct. Stale completions cannot advance superseded work. Use existing atomic
  temporary-write/fsync/replace mechanisms, not competing mutable stores.
- Persist intents before external mutations and reconcile actual outcomes afterward.
  State setting, discoverable creation and ambiguous non-idempotent writes need
  different recovery rules. A negative read after uncertain acceptance does not
  permit blind resend. Keep accepted effects when later steps fail.
- Preserve the source checkout, unrelated work and unsafe/unshipped artifacts.
  Scope agent writes to owned resources. Keep runtime state, context/results and
  process recordings outside repositories. No merge automation, force-push,
  published-history rewriting or cleanup based only on absence/age.
- Restore the original primary session before considering confirmed-loss replacement.
  Refresh task/attachment context. Keep separate review sessions, least-privilege
  credentials, bounded operations, redacted diagnostics and active-safe retention.
- Store observed quality as passed/failed/skipped/uncertain with content identity;
  semantic material-issue dispositions are separate from an AI verdict. Meaningful
  safe output can publish with truthful draft/issues despite adverse advice/checks.
  Genuine primary failure and unsafe publication are distinct from quality failure.
- Validation, review and CI improvement budgets are distinct, persisted before
  dispatch and not reset by restart/poll/self-generated changes. Stop on no-op,
  early finish or exhaustion. Essential outages retain resumable waits; advisory
  outages can be skipped/reported. No task-wide deadline or new crash setting.
- Human merge/closure has terminal precedence. Reconcile already-dispatched effects
  before release. Notification delivery is separate, deduplicated and nonblocking;
  uncertain email never undoes workflow success or authorizes blind resend.

### Component responsibilities

Names below describe responsibilities, not a requirement to rename working classes.

| Component                            | Responsibility and authority                                                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup/configuration                | One validated startup snapshot; canonical integrations/paths, enabled-tool checks and active configuration pins. Distinguish confirmed invalid configuration from unavailable dependencies. |
| Project ownership/registry           | Exclude competing aliases, roots and local/container owners through the same host-visible namespace; point to the pinned active attempt. A PID alone is not authority.                      |
| `Orchestrator`                       | Observe external state, persist arrivals, select transitions and serialize writers; terminal events supersede queued work.                                                                  |
| `RunStore` / existing task stores    | Revision-checked attempt identity, lifecycle, operation, waits, budgets and mutation checkpoints. Large artifacts are referenced separately, not duplicated mutable authority.              |
| `GitClient` / repository operations  | Inspect actual objects/refs, commit relevant output, reconcile unknown effects and push without rewriting published history. Never alter the source checkout.                               |
| `WorktreeManager`                    | Attempt-specific resources, canonical/common-repository provenance, preservation and idempotent owned cleanup.                                                                              |
| `OpenCodeClient` / session execution | Bounded activities, appropriate permissions/models/context, original-session restoration and confirmed-loss reconstruction. Independent product reviews use separate sessions.              |
| Shared process execution             | Cancellation, operation timeouts, environment/credential boundaries, separate process recordings and sanitized summaries across OpenCode, Git, gh and shell commands.                       |
| `TrelloClient` / `GitHubClient`      | Validate external input and reconcile actual service effects using Free-plan capabilities. External state, not a local success message, establishes acceptance.                             |
| Notification delivery                | Durable event identity and transport outcome, safe known-nondelivery retry and explicit uncertainty; delivery is separate from task success.                                                |

### State and mutation boundaries

Keep attempt lifecycle, the active operation and wait/recovery reasons separate.
Operation identity includes kind, generation, prerequisites, execution status,
budgets and content/session references. Waits distinguish human review, capacity,
dependency outage, manual move, uncertain acceptance and intervention-required state.
Validate allowed transitions centrally and fence stale completion tokens.

Create an attempt before publishing its registry pointer; reconcile interruption
between those writes. They are not a cross-file transaction. Write referenced
artifacts before publishing their references, tolerating harmless orphan artifacts.
Do not introduce full event sourcing or replay commands from log text.

Repeatable state-setting mutations require current-state checks. Discoverable
creation binds actual PR/commit/worktree identity before subsequent effects.
Comments, replies and email may have ambiguous non-idempotent acceptance: correlate
and discover where supported, otherwise retain uncertainty instead of blind resend.
Local generation fencing does not make a remote check-and-write atomic, and the
application must not promise unconditional exactly-once external delivery.
For managed PR body fields, retain the observed-body precondition: detected human
edits cancel only a never-dispatched intent before refresh. Observed later field
drift requires a new repeatable intent, not a cached historical success; this never
authorizes resending an uncertain comment/reply or overwriting detected human text.

## Implementation boundaries

P1–P5 delivery is integrated in the current source baseline. The sections below
retain its intended scope and inherited contracts, not a claim that every original
criterion was fully qualified. Do not reopen historical acceptance work; inspect
current code/tests when changing shared paths. Preserve the concrete unresolved
liveness fence recorded in current progress.

| Selected phase | Behavior guide                                         | Main specification scope                                                                                         | Dependency               |
| -------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------ |
| P1             | Historical scope below: invariant guardrails           | REQ-PR-008, REQ-GIT-001, REQ-MNT-002, REQ-TST-001–003 foundations                                                | None                     |
| P2             | Historical scope below: ownership and attempt state    | REQ-CFG-001–006, REQ-SCH-001, REQ-REC-005 contributions                                                          | P1                       |
| P3             | Historical scope below: execution and diagnostics      | REQ-LOG-001–003, REQ-SEC-001–003, REQ-REC-005/006 contributions                                                  | P2                       |
| P4             | Historical scope below: external mutations             | REQ-WF-001, REQ-PR-005/006, REQ-NOT-001/002 foundations                                                          | P2/P3                    |
| P5             | Historical scope below: recovery, setup and context    | REQ-WF-002/003, REQ-PR-003, REQ-REC-001–006, REQ-IMP-002/004, REQ-ENV-002/003, REQ-CTX-001/002/004 contributions | P3/P4                    |
| P6             | [Advisory implementation/publication](p6-execution.md) | PR-001–004/007, IMP-001/003/005, VAL-001–005, initial CTX/setup/Git/notification integration                     | P4/P5 foundation         |
| P7             | [Observation/scheduling/feedback](p7-execution.md)     | HR-001–006, SCH-002–004, TR-004, WF-003, active-PR/context/session integration                                   | P6                       |
| P8             | [CI/additive maintenance](p8-execution.md)             | CI-001/002, MNT-001–004, maintenance Git/PR/context integration                                                  | P7                       |
| P9             | [Read-only recoverable refinement](p9-execution.md)    | REF-001–005, ENV-002, refinement context/workflow integration                                                    | P6; independent of P7/P8 |
| P10            | [Terminal outcomes/cleanup/retries](p10-execution.md)  | TR-001–003, GIT-003–006, SCH-001, terminal PR/refinement/context/notification integration                        | P7/P8/P9                 |
| P11            | [Final integration/cleanup](p11-execution.md)          | Remaining specified integration, migration/environment/regression gaps and removal of temporary scaffolding      | P10                      |

These are contributions to shared requirements, not a claim that every shared
requirement is fully delivered by its first phase. Read the actual specification
criteria when preparing tasks and inspecting the integrated result. Do not pull
later workflow implementation into the current phase merely because it shares an ID.
Do not miss current-scope criteria because a guide summarizes them briefly.

### P1 — Invariant guardrails and regression foundations

Establish the safety boundary before replacing coordination: remove automatic merge
and force-push/published-rebase execution, reject incompatible `autoMerge` settings,
and preserve work when a safe replacement route is not yet available. Reuse real
Git/process fixtures and stateful substitutes that can expose duplicate effects and
transient unsafe writes, rather than merely checking a final callback or card list.

The conservative refusal of legacy maintenance was intentional, not the final
maintenance design. P8 replaces it with safe additive synchronization; P1 does not
mean all publication, recovery or quality-policy requirements were delivered early.

### P2 — Canonical ownership, attempt state and supported handoff

Make ownership depend on canonical Trello/GitHub identity and a shared host-visible
namespace, not project aliases, runtime-root spelling or plain crash-stranded locks.
Pin active integrations, lists and storage; establish versioned revision-checked
attempts, allowed transitions, operation/wait state and recoverable registry handoff.
Import legacy queue/plan/feedback/maintenance/commit/block references without losing
progress or creating two authoritative writers.

Configuration is strict and loaded once. Active removal/rename/redirection/relocation
cannot silently strand an attempt. Bootstrap checks enabled capabilities before
affected task execution. An unsupported or malformed record remains preserved and
isolates its project; it is never interpreted as an absent task permitting a claim.

### P3 — Shared process, diagnostic and credential boundaries

Apply operation cancellation/timeouts and process-tree handling to every child
family, including Git, gh and clone/bootstrap, not only OpenCode or shell commands.
Use operation-specific environment allowlists and project-isolated credential/model
selection. Keep raw process streams separate from typed sanitized events and public
summaries. Retain task-organized diagnostics at external pinned paths, with active
attempts protected from ordinary retention across restart and idle Human Review.

Known-form secret redaction is not a universal unknown-secret guarantee. Process
group handling also does not prove escaped descendants stopped after supervisor
loss; preserve the current unknown-state fence instead of declaring that gap solved.

### P4 — Durable external mutation and notification reconciliation

Persist intent before dispatch and actual accepted identities before later effects.
Initial commit/push/PR creation must resume the same publication when Trello
synchronization fails. Extend the same outcome vocabulary to card moves/content,
comments/replies, PR body/draft/status changes and cleanup. Verify destination fields,
not merely a successful response shape. Late acceptance after a negative lookup
must not cause a duplicate non-idempotent mutation.

Notification records retain the four supported event types, actual draft/issues,
task links and known-delivery/known-nondelivery/uncertain outcomes. A pre-send flag
is not proof of delivery, and uncertain email never holds task completion hostage.
P7/P9/P10 still own their workflow-specific integration on this foundation.

### P5 — Recoverable primary execution, setup and current context

Replace undifferentiated attention parking with typed resumable checkpoints, bounded
immediate recovery, paced essential-dependency rechecks and deduplicated attention.
Distinguish primary crash, advisory failure, outage, manual move, ambiguous execution
and genuine unrecoverability before versus after PR publication. Monitoring is a
fallback; individual operation bounds do not create a task-wide deadline.

Reuse the exact primary session first. Only confirmed loss permits reconstruction
from retained task/repository/plan/attachment/change/history/feedback context, with
old/replacement identities preserved and verification before writable continuation.
Refresh attachments on relevant resumed activities and respect optional per-activity
model/variant choices without substituting an unavailable explicit selection.

Run configured setup before both refinement and implementation. Persist setup effects
independently, reuse verified completion safely, and preserve unrelated output.
Task-relevance judgment belongs to OpenCode; uncertainty is not permission to commit
everything. P6/P9 complete publication/refinement composition, P7/P8 active-PR routes,
and P10 fresh-attempt/terminal handoff. Current carryovers remain in progress, not
hidden prerequisites to redo all P5 work.

### P6 — Advisory initial implementation and truthful publication

Separate quality advice from publication safety throughout schemas, prompts,
callers and restart paths. Attempt planning/reviews, bound distinct improvement
cycles and publish meaningful safe output with truthful normal/draft status rather
than requiring AI approval or passing checks. Preserve primary-crash exceptions,
source isolation, setup exclusions and uncertain commit/publication recovery.
Initial descriptions, notifications, clarification/no-output and draft-to-ready
behavior are included. [P6 guide](p6-execution.md) supplies the task-level scope.
This contribution is implemented and validated; [current progress](phase-status.md)
records the completion checkpoint. Later active-PR workflow changes remain in P7/P8.

### P7 — Active observation, fair capacity and human feedback

Persist arrivals while a single writer executes, separate project occupancy from
AI slots, and schedule human work before CI/maintenance. Keep current feedback
separate from immutable handling history; semantic actionability belongs to
OpenCode. Current semantic feedback refresh precedes arrival dispatch/priority so
automation and unchanged exhausted requests cannot monopolize the queue.
Correct on the same PR/session, with truthful partial replies and current
managed status. Human merge/closure fences stale work and reconciles dispatched
effects; final cleanup/retry belongs to P10. See the [P7 guide](p7-execution.md).
This contribution is implemented and locally validated; [current progress](phase-status.md)
records its integrated checks. P8 execution and P10 cleanup/retry expansion have not
been pulled into this phase.

### P8 — Durable CI episodes and additive maintenance

Observe expected current-head checks with a durable bound and truthful uncertainty.
Tie repair budgets to initiating events, not changing SHAs, polls or reruns. Restore
automatic target synchronization using additive merge plus ordinary push, including
conflict assistance, while preserving published objects, setup exclusions, unshipped
work and terminal precedence. Do not resurrect legacy rebase/leased-push paths.
See the [P8 guide](p8-execution.md).
New maintenance operations explicitly identify additive merge provenance; legacy
records without it remain fenced. Default automatic discovery retains the
per-project opt-out. Safe merge publication includes advisory quality and truthful
draft/outcome reporting in the same behavior, rather than enabling an incomplete
writer before its quality/publication integration exists.
This contribution is implemented and locally validated; [current progress](phase-status.md)
records the integration corrections and final checks. P9/P10 work remains separate.

### P9 — Recoverable, read-only refinement

Use the post-setup repository baseline and external result artifacts; the refinement
activity cannot write repository content. Validate the complete result before card
mutation, journal original/intended/verified fields, detect supported human-edit
races and complete or compensate only attributable writes. No atomic Trello update
claim, blind rollback, automatic split or artificial implementation. Verified full
Backlog outcome releases the attempt. See the [P9 guide](p9-execution.md).
Conclusive bounded field rejection retains its original journal evidence and
switches to verified own-write compensation. Human or unknown acceptance cannot
authorize compensation, and restoration must itself be verified before failure.
This contribution is implemented and locally validated;
[current progress](phase-status.md) records scoped criteria and integrated checks.
P10 cleanup/fresh retries and P11 temporary-guidance removal remain separate.

### P10 — Terminal obligations, artifact preservation and fresh retries

Compose human terminal precedence with verified Done/Backlog/Failed outcomes and
required comments before active-task release. Keep notification uncertainty separate.
Cleanup proves ownership and preserves dirty and clean-unshipped work; unmerged
closure retains accessible implementation. Explicit requeue creates distinct clean
resources from current default/card/context, never implicitly inherits rejected code.
Archive/release/new-attempt handoff must recover across interruption. See the
[P10 guide](p10-execution.md).
Retain terminal attempt records in place as history rather than moving
authority into a second archive. Subsequent attempts own distinct suffixed resource
names; supported older active attempts retain their original persisted identities.
This contribution is implemented and locally validated; [current progress](phase-status.md)
records the integrated result. P11 final integration/temporary-guidance removal
remains separate and has not started.

### P11 — Final integration, supported migration and removal of scaffolding

Close concrete remaining workflow, environment, migration and regression gaps;
retire contradictory legacy authority after supported state can migrate or drain.
Make product/operator docs stand alone, then remove this temporary folder and
remaining rewrite-delivery vocabulary, preserving legitimate lifecycle phases and
runtime fields. This is
not a return to exhaustive live qualification or evidence archives. See the
[P11 guide](p11-execution.md).

## Task sizing and scope control

Prepare an ordered list of the smallest coherent, independently checkable behavior
changes within the selected phase. Each task includes the necessary production
callers, state compatibility and focused regression; do not create separate helper,
wiring or paperwork microtasks. Split independent behaviors; keep tightly coupled
state/caller changes together. Existing numbered guide items are starting points,
not a minimum or maximum task count.

For each task establish the relevant specification criteria, concrete code entry
points, completion behavior, dependencies and focused checks. Keep this information
in the working task list or existing guide, not a new manifest. Execute and review
one task at a time before building dependent work on it. Inspect code, callers,
compatibility and relevant tests against that task's specification criteria. Resolve
findings in small corrections; re-review affected paths rather than restarting audits.
When explicitly authorized, create a small local commit after task review/checks pass.
Otherwise retain the working changes. No per-task full validation, evidence archive
or live qualification gate is required.

At the end, inspect combined phase integration and full scoped specification coverage,
using prior task reviews rather than repeating all local review. Systemic failures
require diagnosis and a revised small-task plan, not one enormous correction request.

## Compatibility and completion

Preserve supported deployed/P5 state and unsupported originals; the approved
[decisions](p6-decisions.md) give the support boundary and recovery policy. Migration
is a recoverable handoff, not permission to forget an externally accepted effect.
Quiesce old writers before rollout, keep canonical path/namespace identity, and
never restore an old snapshot past later accepted mutations or local work.
Release task ownership only after required terminal effects and resource preservation
are established; deferred cleanup must not interfere with new attempts.

### State-specific preservation rules

| Existing state                                                     | Required handoff                                                                                                                                                              |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active Working task with primary session and dirty worktree        | Preserve exact files/identity and reconcile owner/process/session/Git/card state before continuation. Never publish interrupted primary work solely because a diff exists.    |
| Idle Human Review PR or active correction                          | Retain original PR, published commits and project occupancy. Import feedback/pending work and apply terminal precedence before resuming mutations.                            |
| Prepared legacy rebase or push intent                              | Never dispatch the old push. Preserve backup refs, rewritten objects, published history and local work. Reconcile remote acceptance before preparing an additive replacement. |
| PR exists without a durable local binding                          | Discover and bind only with verified provenance. No replacement PR or next task while association is uncertain.                                                               |
| Interrupted refinement without trustworthy original fields/history | Preserve current fields and artifacts; do not invent an original snapshot or claim rollback. Pause conflicting writes for reconciliation.                                     |
| Setup output mixed with task changes                               | Retain attribution/diff history and exclude unrelated output without deleting it. Unknown task relevance blocks unsafe inclusion, not quality-only delivery.                  |
| Stale lock, orphan process or inaccessible session                 | Age/PID absence cannot establish safe takeover. Reconnect before reconstructing; unknown ownership/execution remains fenced.                                                  |
| Failed or closed historical attempt                                | Preserve old code/logs separately; explicit requeue creates new clean resources/current context. Deferred cleanup requires preservation and noninterference.                  |
| Active configuration identity/path change                          | Reject or defer until safe terminal handoff. Import at pinned storage does not authorize silent relocation or a second owner.                                                 |

### Rollout and rollback rationale

- Stop old claims/writers before enabling a new owner; a new lease cannot fence an
  older binary that does not understand its namespace. Local and container services
  must see the same coordination identity and storage, with compatible permissions.
- Import at pinned storage with original records/artifacts retained. Validate the
  candidate and publish recoverable pointers only when their referenced state exists.
  Resume interruption through reconciliation, not replay of external commands.
- Preserve sessions, worktrees, PRs, commits, budgets and completed effects. An older
  record lacking proof receives a preserved reconciliation state, not invented intent.
- Support existing open-PR attempts through import/resumption or explicit safe
  blockage; do not require every Human Review PR to close merely to ship compatible
  behavior. Retire compatibility readers only after supported attempts migrate/drain.
- Prefer a forward fix when an older release cannot read current state. Reverse
  migration is safe only while quiesced and without forgetting later accepted effects.
  Never roll back remote history, resend uncertain comments, discard unshipped work
  or redeploy contradictory merge/force-push routes to recover.

These are code and operational constraints when a handoff is actually changed,
not a new inventory/reporting exercise or permission to deploy from this task.

Complete one selected phase when its specified contribution is integrated, relevant
regressions pass, concrete in-scope defects are resolved and final `yarn validate`
passes. Local reviewed-task commits require explicit session authorization; absent
that authorization, leave changes unstaged and uncommitted for user review.
No automatic next phase, PR, push or deployment.

P11 also removes this entire folder, remaining rewrite links and rewrite-phase
labels from tracked contents/filenames. Application lifecycle phases, runtime fields
named `phase` and ordinary Git rewriting are not delivery metadata; preserve them.
Do not rename persisted fields just to eliminate a word. Preserve useful product guidance and
keep behavior-named regression tests. Git history is the archive; no final evidence
report or replacement planning subsystem is needed.
