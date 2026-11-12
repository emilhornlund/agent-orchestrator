# Recovery

[README](../README.md) | [Workflow](workflow.md) | [Configuration](configuration.md) | [Operations](operations.md)

The orchestrator uses one durable task-session workflow. Recovery is conservative: it reconciles persisted ownership with
authoritative Trello, Git, GitHub, and OpenCode-session evidence. It never guesses, silently advances after an uncertain external
operation, or discards agent work to make polling continue.

## Recovery principles

Only one repository-mutating task may own a project at a time. Independent projects remain isolated and may proceed concurrently.
An unknown or ambiguous task record, queue owner, worktree, branch, session, PR identity/head, or external result fails closed;
inspect the state before deliberate operator action.

Do not hand-edit or remove runtime records to bypass a guard. Preserve these artifacts under the configured `contextRoot`:

```text
registry/<integration-hash>.json                 canonical active-attempt pointer
attempts/<attempt-id>.json                       versioned progress, owner generation, sessions, queue, budgets, effects
artifacts/                                      referenced context, migration snapshots and process evidence
history/                                        task events and session logs
```

These versioned and revisioned records are authoritative runtime data, separate from
the source checkout and task worktrees. Compatibility projections inside the attempt
retain task-execution, plan, feedback, queue and maintenance state under the same
revision/owner fence; they are not independent writers. Pre-upgrade directories such
as `task-executions/`, `task-plans/`, `feedback-ledgers/` and `task-mutation-queues/`
are retained as import evidence, not the current authority after import. The host
coordination directory separately holds integration leases and pinned active-attempt
references. Back up both state and coordination data while quiesced. Malformed or
ownership-mismatched state remains preserved and blocks unsafe continuation.

Also inspect the attempt's recorded worktree/branch, Git status and head, trusted commit
record, authoritative Trello list/history, GitHub PR identity/head, and the per-card session log when present. Never delete an
unknown worktree or discard changes as a first response.

## Restart and task ownership

New initial publications use a durable initial-publication checkpoint.
Commit, push, PR creation and initial Trello synchronization retain their original
mutation intents and verified identities across restart. These checkpoints use
automatic paced rechecks when GitHub or Trello is unavailable; they do not enter
the older exhausted/manual-Ready recovery policy described below. Do not move a
publication-waiting card to Ready to request another claim. Ambiguous dispatch
without acceptance or non-delivery proof remains owned and explicitly pending.
Legacy trusted commits without publication dispatch provenance are preserved for
explicit reconciliation, not automatically upgraded into permission to create a PR.

After restart, `pollProject` calls the unified task-session coordinator. It checks queue ownership and persisted task phase before
resuming any work. The primary session is verified with
`opencode session list --format json --pure --max-count 10000` from the owned worktree; its ID and directory must match the
recorded binding. Implementation, CI correction, and feedback remediation first reuse
the exact stored session ID; the service does not use implicit `--continue`.
A replacement is permitted only after confirmed original-session loss and verified
reconstructable task/repository/plan/attachment/change/history/feedback context.
Original and replacement references, hashed sanitized context and the read-only
baseline remain durable. Ambiguous creation or unverifiable original availability is
not permission to create another session. Bound reconstruction acknowledgement uses
bounded recovery and preserves the primary work's identity/accounting separately.

Recognized structured provider outages retain the checkpoint for paced rechecks,
including across the process-result/ledger-completion gap; ordinary test text naming
a transport error is not outage proof. Unknown running evidence after supervisor
loss remains explicitly ambiguous until authoritative termination can be established.
The known escaped-descendant limitation is not proof that the process stopped or
permission for a competing writer.

A queued `Ready for Agent` claim resumes only when its persisted event identity and expected owned worktree/branch match the
card. An owned `Working` implementation resumes from its recorded phase only after validating task identity, setup state,
worktree, branch, head, session binding, and relevant trusted publication evidence. A trusted published commit can be reused;
recovery never creates a duplicate commit, push, or PR. Refinement events use the same project mutation queue and expected
attempt-owned worktree; ambiguous ownership preserves the queue and blocks subsequent mutations.

If a different live worker owns the queue, a second poll does not steal its event. A failed or uncertain event retains ownership
until verified recovery; do not manually clear it to start another task. Exhausted
quality improvements are reported on the existing draft PR, not restarted by normal
polling. New substantive human requests can begin another feedback cycle; unchanged
requests, incidental edits and new agent commits cannot renew exhausted work.

### Supported upgrades

Current version-1 attempt envelopes resume at their pinned storage path with
revision/owner checks. Supported earlier version-1 task-execution records and their
associated plans, feedback, queue, maintenance, commit, conflict and session
references are imported into one canonical attempt. Compatibility includes the
historical writer state represented by commit
`f8ac2eaa3991a3c2b6b8b4b98945e06076140050`; arbitrary intermediate experimental
formats are not a promised support target. Identify the actually deployed release
and its record shapes before a rollout rather than inferring deployment from this
checkout or the application package version.

Stop old writers first: a new lease cannot fence an older binary that does not use
the shared coordination namespace. Keep project IDs, board/list mapping,
repositories, worktree roots and state paths unchanged while an attempt is active.
Compatible operational settings (models, commands, polling) take effect on restart.
Unsupported/corrupt originals and immutable migration snapshots are preserved;
interruption between candidate and pointer writes resumes the handoff rather than
replaying external operations. A valid other-integration pointer can isolate its
unreadable record so healthy projects continue. Unattributable or conflicting
records remain fenced; they are never treated as an empty project.

Import preserves sessions, dirty work, PRs, commits, counters and pending effects,
but cannot invent missing dispatch, stopped-process or refinement-history proof.
Such work remains explicitly blocked for reconciliation. Legacy rebase intents
never become permission to force-push or replay the old writer. Keep supported
compatibility readers until active attempts can migrate or drain safely.

Prefer a forward correction when an older binary cannot read current state. Do not
restore a snapshot over later accepted remote effects or unshipped local work.
Rollback requires quiesced writers and verified state compatibility; it never
authorizes remote-history rollback, uncertain comment resend or code disposal.

## CI waiting, failure, and repair

CI expectations come from available branch-protection rules and reliable static repository workflow contracts. Check runs and
commit statuses are observed for the exact persisted PR head. Conditional/dynamic workflow contracts, inaccessible policy,
empty expectations, delayed check registration, pending or queued jobs, cancelled/skipped/neutral results, and stale or malformed
observations cannot become a pass. If expectations are incomplete or uncertain, the task remains waiting/fails closed with an
explicit diagnostic; no repair attempt is consumed and auto-merge is prohibited.
The per-revision observation window is persisted and bounded at 30 minutes. Expiry
ends that CI phase in Human Review with uncertainty disclosed, not a pass or task
failure; later polls still observe results.

Only a complete expected-check set with every expected check terminal can produce a failure result. All failures for that head
are collected together before the primary session is asked to repair. After each bounded correction the orchestrator reruns local
validation, configured coverage, independent review, safe publication, and complete CI observation against the new head. The
repair counter is persisted and finite. When the limit is reached, the PR and worktree remain available for a human; no new PR is
created. Its `ciMaxPasses` budget (default two) survives own commits, reruns, restart
and routine synchronization. A verified new substantive human request may begin a
new episode; continuing failure or a new SHA alone cannot.

## Feedback and replies

Review bodies, inline threads, and conversation comments are tracked by stable GitHub identity in the task ledger. New comments do
not erase earlier still-applicable unresolved feedback. Actionable items are resumed in the primary session and independently
verified against current content/head. Available corrections publish to the same
PR despite adverse advisory checks. Replies distinguish verified, unresolved and
uncertain fulfillment against the observed published head; pending or failed CI is
disclosed, not a reply gate. A no-op never proves a fix. An uncertain send is reconciled by its stable marker before retrying; do not send a
duplicate reply manually. The service does not approve reviews, dismiss decisions, or resolve reviewer threads.

## Terminal pull requests

An authoritative merged PR moves its card to `Done`; a deliberately closed unmerged PR moves its card to `Backlog`. A persisted
terminal queue event owns the operation across external moves and cleanup. On restart, polling rechecks PR identity/state and
resumes the matching event. Repeated terminal transitions do not merge again or duplicate destination moves/comments. If
ownership, PR metadata, or a Trello move is uncertain, the queue and recovery information remain in place.

The expected remote branch is deleted only for a verified merged PR and only after it is known to belong to the owned task. The
local worktree cleanup is restricted to the expected path and branch and refuses symlinks, dirty trees, active rebases, conflicts,
or unknown paths. It also preserves ignored setup output and clean local-only
commits. Closed-PR cleanup requires accessible PR commit history. Known owned
isolated resources may remain preserved without blocking terminal release; unknown
identity, execution or pending effects cannot. Required terminal moves and comments
must be verified before the next task. An unknown comment outcome remains pending
even when the card already appears in its destination list.

## Additive maintenance and legacy rewrite fences

Current maintenance merges the pinned target commit into the existing published
task branch, retaining previous commits and the same PR. Persisted provenance,
pre-dispatch file/index baselines, expected merge parents/tree and exact remote
head establish recovery. An accepted merge or push is observed rather than
repeated. Unknown execution or remote acceptance retains ownership and explicit
reconciliation; an absent branch never authorizes recreation after human closure.

Unrelated staged output and unknown local-only commits are not automatically
included. Refusal retains the queue's recovery identity so safe maintenance can
resume after the blocker is resolved. Unstaged excluded setup output is retained
byte-identically. Conflict assistance is bounded and uses the primary task
session; no-op or exhaustion preserves the unresolved merge rather than staging
unchanged markers. Manual resolution does not authorize shipping unrelated index
changes: preserved non-conflict and pre-merge baselines are rechecked on recovery.

Legacy rebase/continue and force-with-lease paths remain disabled, including
apparently unpublished conflicts. Preserve their maintenance records, worktrees,
backup refs, rewritten objects, dirty/unshipped changes and remote history for
operator reconciliation. Ordinary initial publication requiring no history
rewrite remains supported. Do not blindly retry uncertain pushes or reset,
abort, clean or discard preserved work.

A legacy `attention-required` record without a persisted `terminalFailure`
cannot be automatically moved to Failed or discarded. Polling now logs the
blocked condition once per process without emitting the same Attention
Required email every 15 seconds; its queue event and files remain intact
for explicit operator recovery. This is **not automatic restoration** of an
existing dirty publication worktree: inspect its Git status, trusted commit,
and persisted task state before deciding how to resume or salvage the PR.

## Failed, unpublished PR maintenance and removed tasks

Legacy maintenance records of every status are treated conservatively. Status
labels, missing remote branches, and OPEN-only PR lookups do not prove that a
clean local rewrite was shipped or never published. Do not cancel, retire,
retry, or clean up records, refs, objects, publication intents, handoffs, or
worktrees automatically. Read-only PR observation and independently verified
terminal reconciliation may continue; any legacy maintenance artifact causes
terminal cleanup to preserve the local worktree and related evidence.

A queued or interrupted terminal-PR mutation may outlive its Trello card.
If that card is absent from the Human Review list, polling verifies the
exact PR by its stored number, URL, original task ownership, base and head
identity, and terminal state. Only then can it complete the orphan event
**without recreating or moving the missing Trello card or deleting the
worktree**. A mismatch or unavailable authoritative PR evidence remains
blocked with a diagnostic rather than being guessed.

These safeguards do not authorize retiring an ambiguous push, live owner,
active conflict, or unknown repository mutation. Preserve state and seek
operator recovery in those cases.

## Prepared publication conflicts

A legacy active conflicted rebase may have a persisted handoff below the configured worktree root:

```text
.orchestrator/prepared-conflicts/<project-id>/<card-id>.json
```

The handoff and conflict worktree are preserved without abort, reset, cleanup, removal, recreation, or OpenCode continuation. No
automatic publication or recovery of that legacy rewrite is attempted. The affected task remains blocked until an operator reconciles history.
A malformed handoff, missing remote branch, or apparent completed rebase is not proof
that automatic continuation is safe.

## Deliberate retry and operator actions

For a reconciled failed task, move the card to `Ready for Agent` to request a fresh attempt. No internal-file edits are needed.
The new attempt uses the latest fetched default branch, current card and attachments, and fresh session/progress state.
Earlier unfinished code, worktrees, execution records and logs remain isolated under their old attempt identities; they are
not automatically incorporated. A deliberately requeued closed PR follows the same rule: rejected code is historical context,
not accepted implementation. Cards left in `Failed` do not automatically retry.

Read resource paths from the attempt record when inspecting newer attempts. Card-only path examples below describe older
attempts; subsequent attempts use `<card-id>--<attempt-id>` in the worktree and branch names. Keep the original resource
identities when recovering an existing attempt rather than guessing or renaming them.

Automated failures move a card to `Failed` only after that Trello transition succeeds. Failure comments provide the category,
reason, and deliberate retry instruction. Move a card from `Failed` to `Ready for Agent` only when intentionally requesting a
new pass. Normal polling never retries `Failed` cards automatically.

If Trello or GitHub returns a retryable transient error, owned active work retains
its last verified checkpoint and paced dependency wait. It resumes automatically
after safe readback; a Ready move is not required merely for a service outage.
For a retained legacy reconciliation block only, an exhausted card-scoped block is released by moving the affected card from its recorded reconciliation
list to `Ready for Agent`; a cardless project-level block requires resolving the external problem and restarting the worker.
Authentication, malformed responses, unknown persisted data, or unsupported state are not treated as transient success.

When investigating an `Attention Required` card, compare the durable record/queue with Trello list history, PR state and head,
worktree branch/head/status, trusted commit, primary session, complete CI evidence, and unresolved feedback. Do not start a second
task in the project while the current task has ambiguous ownership. Contact a human when the available evidence does not establish
a safe deterministic continuation.

### Explicit recovery tooling

Stop the normal service before running an operator command. Commands use the same
configuration, shared namespace and canonical attempt authority, and refuse a live
or ambiguous competing owner. From a checkout with development dependencies:

```sh
yarn reconcile:external-pr --project ID --card ID --commit SHA --branch BRANCH --pr NUMBER
yarn recover:legacy-mutation --project ID --event EVENT_ID --confirm-never-started
```

For a production image, the equivalent entry points are
`node dist/operator/reconcile-external-task-session-pr.js` and
`node dist/operator/recover-legacy-retired-mutation.js` with the same flags and
persistent mounts. Use external-PR reconciliation only for independently verified
salvage of the retained implementation through an already human-merged recovery PR.
It verifies branch/base identity, equivalent implementation content, commit history,
CI and Trello location before reconciling Done; it does not create a replacement
PR or authorize rewriting published history. Never use it to associate unrelated work.

The legacy-mutation command is narrower: it retires only a completed legacy Ready
event whose execution never started, with no task-execution owner, after verifying
Ready membership and absence from Working. The confirmation flag is an operator
assertion, not something inferred from PID absence. It cannot clear started,
failed, ambiguous or actively owned work.

For an imported legacy `attention-required` implementation without terminal-failure
proof, an explicitly authorized move to Failed can retire the matching legacy queue
event after identity/owner checks, but does not invent canonical terminal evidence
or guarantee project release. Preserve original work and seek explicit reconciliation
when canonical proof is missing. Do not use stale pre-import JSON files as current
authority or move the card repeatedly between lists to bypass that fence.

Current genuine primary failures use bounded recovery (three verified genuine
failures per semantic operation), then automatically reconcile Failed and its
comment before release when no PR exists. Outages and reconstruction have separate
accounting; a nonzero validation result is not a primary crash. An open PR instead
retains ownership and a recoverable operational blockage. Normal recovery and
deliberate retries never require internal-file edits. Unsupported or ambiguous
state that cannot be established safely stays preserved for operator/support
resolution rather than receiving a destructive generic reset command.

Recovery has been tested only with local fixtures and mocked services. No live Trello/GitHub pilot, real OpenCode session restart,
or external API availability test has been performed.
