# Recovery

[README](../README.md) | [Workflow](workflow.md) | [Configuration](configuration.md) |
[Operations](operations.md)

The orchestrator uses one durable task-session workflow. Recovery is conservative: it reconciles
persisted ownership with authoritative Trello, Git, GitHub, and OpenCode-session evidence. It never
guesses, silently advances after an uncertain external operation, or discards agent work to make
polling continue.

## Recovery principles

Only one repository-mutating task may own a project at a time. Independent projects remain isolated
and may proceed concurrently. An unknown or ambiguous task record, queue owner, worktree, branch,
session, PR identity/head, or external result fails closed; inspect the state before deliberate
operator action.

Do not hand-edit or remove runtime records to bypass a guard. Preserve these artifacts under the
configured `contextRoot`:

```text
registry/<integration-hash>.json                 canonical active-attempt pointer
attempts/<attempt-id>.json                       versioned progress, owner generation, sessions, queue, budgets, effects
artifacts/                                      referenced context, migration snapshots and process evidence
history/                                        task events and session logs
```

These versioned and revisioned records are authoritative runtime data, separate from the source
checkout and task worktrees. Compatibility projections inside the attempt retain task-execution,
plan, feedback, queue and maintenance state under the same revision/owner fence; they are not
independent writers. Pre-upgrade directories such as `task-executions/`, `task-plans/`,
`feedback-ledgers/` and `task-mutation-queues/` are retained as import evidence, not the current
authority after import. The host coordination directory separately holds integration leases and
pinned active-attempt references. Back up both state and coordination data while quiesced. Malformed
or ownership-mismatched state remains preserved and blocks unsafe continuation.

Also inspect the attempt's recorded worktree/branch, Git status and head, trusted commit record,
authoritative Trello list/history, GitHub PR identity/head, and the per-card session log when
present. Never delete an unknown worktree or discard changes as a first response.

## OpenCode provider authentication failures

An OpenCode provider error such as `Token refresh failed: 401` indicates an authentication/access
failure for the configured provider. It is not by itself evidence of a failing test assertion or
validation check. Inspect the affected OpenCode execution and any validation command output to
establish which operation failed and whether validation actually ran.

Use the affected attempt's pinned storage root and diagnostic references, rather than guessing paths
from the current configuration. As described in
[Logging and retention](operations.md#logging-and-retention), task output is separate from the
structured service log:

- Per-card session log:
  `<pinned-storage-root>/history/sessions/<sanitized-project-id>/<sanitized-card-id>-<attempt-id>.log`.
- Child-process output: the pinned attempt's
  `artifacts/<project>/<card>/<attempt>/process-executions/` tree. Inspect the relevant execution's
  `stdout.txt` and `stderr.txt`, including the validation process artifacts when checking test
  results.

Repair provider access under the actual account/runtime identity running the service or task, using
its effective OpenCode configuration and authentication store. Authenticating in an operator's own
shell may not repair the service account's access. Follow the
[OpenCode configuration guidance](configuration.md#projectsopencode) for provider selection,
auth-store use and effective configuration locations, and
[local/container installation guidance](operations.md#local-and-container-installation) for service
identity and persistent home/authentication storage. Credential locations depend on that runtime's
setup; the orchestrator does not provide a provider-credential refresh procedure.

Never paste tokens or other credentials into Trello cards, logs, or shared diagnostics. Redact
sensitive values before sharing output, following [SECURITY.md](../SECURITY.md). Preserve the
attempt's state and worktree, then follow the existing
[deliberate retry and operator actions](#deliberate-retry-and-operator-actions) for its recorded
recovery condition; repairing authentication alone is not permission to bypass an ownership or
attention fence.

## Refinement recovery after repository setup

A successful setup checkpoint is reused when an interrupted refinement resumes. Setup inventories
include ignored dependency files; the artifact reader and writer share a 256 MiB size ceiling.
Previously, the writer could save inventories exceeding the reader's 16 MiB ceiling, leaving a
completed setup unreadable on every subsequent poll. Existing content-addressed artifacts within the
new ceiling are read directly, with the original digest and worktree identity checks intact. They do
not require a new attempt, another dependency installation, or replacement of the baseline.

To recover this condition after upgrading, keep the same configuration, runtime/coordination
volumes, repository, and worktree mounts. Do not move the card out of `Working`, clear its records,
or delete its worktree. The next poll resumes its existing attempt and verifies the saved setup
before refinement. Successful refinement returns the card to `Backlog`; it does not implement the
card or move it to `Done`. A missing, modified, oversized, or identity-mismatched artifact is still
preserved and requires its reported cause to be resolved; the upgrade does not bypass safety checks.

Other refinement recovery failures retain a sanitized causal diagnostic and a durable recheck
schedule (one minute initially, increasing to at most five minutes). Ordinary polls and restarts do
not reset that schedule or the attempt count. Local internal failures are limited to three attempts;
exhaustion only enters the existing verified `Failed` transition when setup/analysis processes are
proven stopped, external operations are conclusively resolved, and no refinement field update is
pending. Original card fields and worktree evidence are preserved. An exhausted attempt is never
redispatched while stopped-process or external-effect proof is missing.

Explicit safety ambiguity and retryable Trello outages use controlled reconciliation waits rather
than consuming the internal-failure allowance. Ownership is retained until recovery is verified;
unchanged causes do not generate an attention email on every poll. Resolving the dependency permits
the next scheduled recheck to resume the same attempt. Human edits and uncertain partial card writes
continue to require their existing conservative field/history reconciliation.

## Implementation setup inventory and preparation recovery

Implementation setup inventories and setup-attribution evidence use the same bounded 256 MiB
artifact storage as refinement inventories. Captured AI/process results retain their separate 16 MiB
limit. Before/after inventories, recovered setup output, and the later publication scope all use the
setup-specific reader and writer; digests, permissions and worktree identity checks remain enforced.
Existing content addresses and storage layout are unchanged.

An attempt stopped by `Primary result exceeds 16777216-byte limit` while persisting setup evidence
can resume after upgrading with the same configuration and persistent mounts. Leave the card in
`Working` and preserve its worktree, coordination records and runtime state. Recovery adopts a
verified successful setup execution rather than reinstalling dependencies, then continues the
implementation workflow. A successful implementation proceeds toward a PR and `Human Review`, not
the refinement workflow's `Backlog` destination.

Internal preparation failures before the first AI dispatch are counted separately from setup command
executions. Capture, artifact-storage and setup-checkpoint failures share a durable three-attempt
allowance, including reconciliation after restarts. Rechecks start after one minute and increase to
at most five minutes; restarting does not reset them. A transient failure can recover without
replaying successful setup. When recovery is exhausted, the service stops repeating the failed
preparation and uses the existing verified `Failed` transition, failure comment and notification
protocol. Worktrees and diagnostics are preserved; project ownership is released only after terminal
synchronization is confirmed.

Terminalization requires stopped-process evidence (or an authoritative pre-dispatch checkpoint),
resolved external mutations, no AI session/operation and no publication. A GitHub lookup must also
exclude an existing PR for the owned branch. Missing process evidence, existing PRs and external
outages remain explicit paced waits, not permission to overwrite work or declare failure. Shutdown
is not charged as an internal failure. This preparation boundary does not replace post-dispatch AI
recovery or draft-PR delivery when quality gates cannot pass.

## Restart and task ownership

If startup reports that project ownership is already held, inspect the recorded owner PID in the
error: another foreground or background instance may still be running and polling. Stop that
instance gracefully before starting a replacement. Kernel locking determines ownership; a retained
lock pathname or old owner metadata alone does not mean the project is locked, and deleting those
files is not a recovery procedure.

New initial publications use a durable initial-publication checkpoint. Commit, push, PR creation and
initial Trello synchronization retain their original mutation intents and verified identities across
restart. These checkpoints use automatic paced rechecks when GitHub or Trello is unavailable; they
do not enter the older exhausted/manual-Ready recovery policy described below. Do not move a
publication-waiting card to Ready to request another claim. Ambiguous dispatch without acceptance or
non-delivery proof remains owned and explicitly pending. Legacy trusted commits without publication
dispatch provenance are preserved for explicit reconciliation, not automatically upgraded into
permission to create a PR.

Initial PR title/body/draft readback uses a bounded authenticated GitHub API read rather than CLI
display output: some CLI releases rewrite terminal escape sequences even in JSON, which can make an
unchanged body appear different from its publication intent. The read uses the project's App token
or ambient token; an authenticated CLI credential can be obtained in memory when needed. Credentials
and authentication-command output are never logged. Exact body comparison and the original
publication journal remain intact, so recovery adopts the existing PR without rewriting its body or
creating another PR.

After restart, `pollProject` calls the unified task-session coordinator. It checks queue ownership
and persisted task phase before resuming any work. The primary session is verified with
`opencode session list --format json --pure --max-count 10000` from the owned worktree; its ID and
directory must match the recorded binding. Implementation, CI correction, and feedback remediation
first reuse the exact stored session ID; the service does not use implicit `--continue`. A
replacement is permitted only after confirmed original-session loss and verified reconstructable
task/repository/plan/attachment/change/history/feedback context. Original and replacement
references, hashed sanitized context and the read-only baseline remain durable. Ambiguous creation
or unverifiable original availability is not permission to create another session. Bound
reconstruction acknowledgement uses bounded recovery and preserves the primary work's
identity/accounting separately.

Recognized structured provider outages retain the checkpoint for paced rechecks, including across
the process-result/ledger-completion gap; ordinary test text naming a transport error is not outage
proof. Unknown running evidence after supervisor loss remains explicitly ambiguous until
authoritative termination can be established. New managed commands run in private PID namespaces:
namespace-init exit terminates even detached descendants. This does not retroactively prove that
older process-group-only executions stopped, or turn missing finalization evidence into permission
for a competing writer. Retained ambiguous executions still require authoritative reconciliation.

Verified intentional cancellation of a primary operation is accounted separately from genuine
failures. Restart retains the actual dispatch count, session binding and source changes, and retries
only after process-stop verification; repeated cooperative shutdowns do not exhaust the primary
operation's three-genuine-failure allowance. A coincident genuine nonzero exit, timeout, malformed
process evidence or uncertain stop remains a failure or ambiguity, rather than being hidden by the
shutdown signal.

A queued `Ready for Agent` claim resumes only when its persisted event identity and expected owned
worktree/branch match the card. An owned `Working` implementation resumes from its recorded phase
only after validating task identity, setup state, worktree, branch, head, session binding, and
relevant trusted publication evidence. A trusted published commit can be reused; recovery never
creates a duplicate commit, push, or PR. Refinement events use the same project mutation queue and
expected attempt-owned worktree; ambiguous ownership preserves the queue and blocks subsequent
mutations.

Published-task recovery and CI repair resolve the worktree and branch from the canonical attempt's
recorded resources. Later attempts may use `<card-id>--<attempt-id>`; reconstructing a card-only
path is not valid recovery evidence. A genuine missing or mismatched worktree remains fenced. New
recovery escalations retain a sanitized `recoveryAttentionReason`, so subsequent polls expose the
original blocker rather than only reporting that the task was already escalated. Correcting an
environment or software defect does not automatically clear an existing attention fence; the
original attempt must be revalidated under its project lease before resumption.

### Reviewed implementation interrupted before its first commit

A completed review cycle can legitimately leave meaningful implementation changes uncommitted while
publication prepares its commit metadata and final quality observations. Failed/uncertain
validation, negative review, and a `no-change` repair outcome still require draft PR delivery; they
do not turn the implementation into an ambiguous or failed task merely because the worktree is
dirty.

Startup revalidates this pre-commit checkpoint against the recorded review's exact source identity,
the owned worktree/branch, unchanged base ancestry, no active merge/rebase/conflicts, and absence of
an existing task commit, remote task branch or PR. The existing session and mutation queue must also
remain verifiable. It then continues publication with the preserved implementation and reruns the
prepared-content checks without renewing implementation/review repair budgets. Remaining concerns
are disclosed on the draft PR, and verified publication advances the card to Human Review.

An older version may already have fenced this exact state with
`Authoritative recovery snapshot could not be read: Publication worktree contains changes not represented by the trusted commit`.
That specific attention checkpoint is eligible for automatic read-only revalidation on the next
startup/project poll, including when its failed implementation event still occupies the queue. It is
reopened only after the complete safety proofs pass. A changed source, different branch,
active/ambiguous writer, conflicting remote effects or unrelated attention reason remains fenced.

For a Portainer upgrade, keep the existing coordination, context, repository and worktree volumes
and deploy an image containing this recovery fix and the project environment mappings. Keep the card
in its persisted expected list (normally Working before its first PR); do not requeue it as a new
Ready task or delete/edit task records to request recovery. A successful revalidation logs
`Recovered reviewed pre-commit publication; continuing PR delivery with the preserved implementation`.
Publication's existing paced journal handles subsequent polls and restarts without duplicating the
commit or PR.

A completed human-feedback writer still owns its validation checkpoint before the first feedback
review cycle is initialized. Recovery resumes that completed operation's quality stage on the
existing PR; it does not treat the Working card as a new implementation claim. Original feedback
identities and queue ownership must remain verifiable, including when a verified replacement session
is used. Missing round context or ambiguous execution preserves the checkpoint and blocks
initial-publication fallthrough instead of replaying the writer.

If a different live worker owns the queue, a second poll does not steal its event. A failed or
uncertain event retains ownership until verified recovery; do not manually clear it to start another
task. Exhausted quality improvements are reported on the existing draft PR, not restarted by normal
polling. New substantive human requests can begin another feedback cycle; unchanged requests,
incidental edits and new agent commits cannot renew exhausted work.

### Supported upgrades

Current version-1 attempt envelopes resume at their pinned storage path with revision/owner checks.
Supported earlier version-1 task-execution records and their associated plans, feedback, queue,
maintenance, commit, conflict and session references are imported into one canonical attempt.
Compatibility includes the historical writer state represented by commit
`f8ac2eaa3991a3c2b6b8b4b98945e06076140050`; arbitrary intermediate experimental formats are not a
promised support target. Identify the actually deployed release and its record shapes before a
rollout rather than inferring deployment from this checkout or the application package version.

Stop old writers first: a new lease cannot fence an older binary that does not use the shared
coordination namespace. Keep project IDs, board/list mapping, repositories, worktree roots and state
paths unchanged while an attempt is active. Compatible operational settings (models, commands,
polling) take effect on restart. Unsupported/corrupt originals and immutable migration snapshots are
preserved; interruption between candidate and pointer writes resumes the handoff rather than
replaying external operations. A valid other-integration pointer can isolate its unreadable record
so healthy projects continue. Unattributable or conflicting records remain fenced; they are never
treated as an empty project.

Import preserves sessions, dirty work, PRs, commits, counters and pending effects, but cannot invent
missing dispatch, stopped-process or refinement-history proof. Such work remains explicitly blocked
for reconciliation. Legacy rebase intents never become permission to force-push or replay the old
writer. Keep supported compatibility readers until active attempts can migrate or drain safely.

Prefer a forward correction when an older binary cannot read current state. Do not restore a
snapshot over later accepted remote effects or unshipped local work. Rollback requires quiesced
writers and verified state compatibility; it never authorizes remote-history rollback, uncertain
comment resend or code disposal.

## CI waiting, failure, and repair

Older versions could finish an unchanged CI correction successfully and then fail its handoff with
`CI repair did not complete; PR and task state are preserved`. The task could remain in `validation`
with an active CI reservation and a failed queue event, even though its primary operation had
completed. That retained checkpoint is now routed back to its exact owning CI episode after normal
PR/worktree/session verification. The saved successful primary result is verified, the source
identity is checked again, and unchanged output ends the cycle without replaying the agent,
rerunning local review or creating another commit. This recovery also applies when CI has since
passed on the same head; current CI observations still determine the disclosed PR outcome.

Keep the existing PR, worktree and state when upgrading.
`CI repair stopped (no-change); existing PR remains available for human review` indicates the old
completion has been reconciled. The same failed CI result cannot restart a stopped episode
automatically; a deliberate new human request is required to authorize further correction.
Unknown/unsuccessful primary results and mismatched episode/head identities remain fenced. Actual
repair failures now include a bounded, redacted cause in their summary;
`Active PR observation deferred (timeout)` remains a separate paced read failure with its detailed
artifact reference, not evidence that a correction failed.

CI expectations come from available branch-protection rules and reliable static repository workflow
contracts. Check runs and commit statuses are observed for the exact persisted PR head.
Conditional/dynamic workflow contracts, inaccessible policy, empty expectations, delayed check
registration, pending or queued jobs, cancelled/skipped/neutral results, and stale or malformed
observations cannot become a pass. If expectations are incomplete or uncertain, the task remains
waiting/fails closed with an explicit diagnostic; no repair attempt is consumed and auto-merge is
prohibited. The per-revision observation window is persisted and bounded at 30 minutes. Expiry ends
that CI phase in Human Review with uncertainty disclosed, not a pass or task failure; later polls
still observe results.

Only a complete expected-check set with every expected check terminal can produce a failure result.
All failures for that head are collected together before the primary session is asked to repair.
After each bounded correction the orchestrator reruns local validation, configured coverage,
independent review, safe publication, and complete CI observation against the new head. The repair
counter is persisted and finite. When the limit is reached, the PR and worktree remain available for
a human; no new PR is created. Its `ciMaxPasses` budget (default two) survives own commits, reruns,
restart and routine synchronization. A verified new substantive human request may begin a new
episode; continuing failure or a new SHA alone cannot.

## Feedback and replies

### External head adoption

Upgrade and restart with the same runtime volumes and project identity. Previously idle sessions
that reported an external-head pause are rechecked on the normal poll; no state edit or Trello move
is needed. The specific legacy attention checkpoint for a mismatched PR identity/head can also
resume from CI or Human Review once the full adoption proof succeeds. Unrelated attention and
dependency recovery checkpoints and unresolved effects retain their existing fences.

The queue retains its owner across interruption. If the branch is still at the recorded local head,
the scheduler may apply the recorded fast-forward after fresh readback; if it is already at the
intended head, it verifies rather than rerunning Git. A newer remote head can supersede an in-flight
target only if it also contains the current local head. If the canonical publication was already
updated, restart finishes the queue descriptor without updating Git again. Closure and merge use
normal terminal reconciliation with interrupted artifacts preserved. Local changes, unpublished
commits, and missing stop or mutation evidence are blockers, not authorization to discard work or
retry an external effect.

Completed feedback and reply identities remain in the ledger. The previous revision's evidence and
budgets remain available through the adoption artifact. A continuing CI failure does not restart a
stopped budget; an exact-head failed check absent from a complete retained failure set can establish
a new episode. If the old failure set is unknown, it cannot establish that trigger.

### Retained published classification or GitHub App credential failure

Keep the original named volumes and mount paths for coordination, context/artifacts, repository,
worktree, and the service user's OpenCode home. Stop the previous service instance before acquiring
the same project lease. Keep the card in its recorded `Human Review` list. The service can reopen an
idle canonical attention checkpoint carrying the earlier classification-failure reason only after it
verifies the original PR and exact head, trusted commit, local and remote branch, clean owned
worktree, original session, prior process termination and absence of unresolved mutation ownership.
An unverifiable prior execution is a blocker, not permission to replace the task.

The same checks apply to older idle `ci` and `human-review` checkpoints that were escalated because
the GitHub App installation-token exchange failed with HTTP 429, HTTP 5xx, or a network error while
reading the authoritative recovery snapshot. In particular, this covers the HTTP 502 incident for
[Klurigo PR #782](https://github.com/emilhornlund/klurigo/pull/782). Start the upgraded service
normally with the original volumes and configuration. When GitHub is reachable and verification
passes, polling restores the owning checkpoint and reads current feedback for the original PR. The
observation artifacts are retained; the existing feedback ledger and mutation queue track the
current requests, including edits/deletions and prior attempts. Reviewers do not need to resubmit
requests that remain current. Do not edit runtime state or reset the card. Invalid App credentials,
insufficient permissions, configuration failures, and unrelated attention reasons are not eligible
for this restoration.

For Klurigo, the expected identity from the incident is project `klurigo`, card
`6b02ade22e99a0a22377c6f9`, attempt `d0f480db-592d-4fa8-80e5-164ae843e695`,
[PR #778](https://github.com/emilhornlund/klurigo/pull/778), and published head
`b3b9d5e01371032ede5356f9c3dadd38c1f93971`. Read the exact branch and worktree from the pinned
attempt. Start the upgraded service normally. Startup reacquires the canonical attempt under its
project lease; polling checks both direct and `process-executions/` metadata layouts. Older workers
could log a classification failure while leaving the task in Human Review; the first classification
after upgrade also checks retained execution evidence before dispatching from that checkpoint.
Recovery does not clear unrelated attention reasons, ambiguous writers, changed branches or heads,
or pending mutations. If the service reports a blocker, preserve the retained evidence and
investigate the specific mismatch in the task log. Do not move the card to Ready or create a second
PR. On successful resumption the service re-reads the two inline requests and classifies them
against the verified head before scheduling any correction in the existing primary session. It will
not mark the requests fulfilled or resolve the threads as a side effect of recovery. This procedure
has not been executed on the Klurigo production volumes.

Review bodies, inline threads, and conversation comments are tracked by stable GitHub identity in
the task ledger. New comments do not erase earlier still-applicable unresolved feedback. Actionable
items are resumed in the primary session and independently verified against current content/head.
Available corrections publish to the same PR despite adverse advisory checks. Replies distinguish
verified, unresolved and uncertain fulfillment against the observed published head; pending or
failed CI is disclosed, not a reply gate. A no-op never proves a fix. An uncertain send is
reconciled by its stable marker before retrying; do not send a duplicate reply manually. The service
does not approve reviews, dismiss decisions, or resolve reviewer threads.

## Terminal pull requests

Terminal process-stop checks retain earlier explicit operator startup-stop attestations. New
attestations bind the exact initial execution IDs and metadata hashes and are referenced durably.
Older retained attestations are recognised only for unchanged, pre-attestation initial OpenCode
metadata with the historical missing-finalization signature, matching attempt/worktree and no
primary-operation ownership. This does not rewrite process history or infer termination from PID
absence; later or unassociated unknown executions remain blocked. A deferred terminal transition
reports the specific process-evidence artifact rather than only a generic cleanup message.

An authoritative merged PR moves its card to `Done`; a deliberately closed unmerged PR moves its
card to `Backlog`. A persisted terminal queue event owns the operation across external moves and
cleanup. On restart, polling rechecks PR identity/state and resumes the matching event. Repeated
terminal transitions do not merge again or duplicate destination moves/comments. If ownership, PR
metadata, or a Trello move is uncertain, the queue and recovery information remain in place.

A merge can supersede an interrupted CI, validation, review or feedback repair. Once stopped
execution and pending-effect proofs are established, terminal preparation retains the complete task
record in an immutable artifact referenced by `terminalInterruption.artifact`. Only then does the
Done projection retire live repair scheduling fields; completed quality evidence, operation history,
attempt budgets and unshipped files are preserved. A human merge does not turn failed checks into
passes, and unknown running processes still block release.

This also recovers older attempts that moved Trello to Done but could not persist completion with
`Active review repair is not valid during the done phase`. On the next startup/poll, the same owned
merged PR is revalidated even if its card is already Done or its task was escalated to attention.
Old valid process-stop proofs remain usable; the interrupted-state snapshot is added before terminal
finalization. Keep the existing state/coordination/worktree volumes and the card in Done. No Ready
move, state deletion, repair replay or new commit is required. The project is released only after
the persisted Done outcome and destination readback are verified; success logs
`Merged task Done state verified and persisted`. A corrupt retained snapshot is preserved as a real
recovery blocker rather than discarded.

Repeated unchanged failures share one attention-notification identity across polls and restarts.
Whitespace and new per-execution `process-executions/<UUID>/` references do not create new alert
events; the first retained payload keeps its concrete diagnostics. Already-confirmed legacy event
obligations are reused after upgrade. Changed semantic failure text, task attempts and commit SHAs
carried in the event identity remain distinct, and ambiguous SMTP acceptance still forbids blind
resending. Pending legacy aliases are coalesced during delivery too: a confirmed or ambiguous send
cannot be bypassed by sending the same alert under another execution-specific ID. Each alias keeps
its actual delivery state; no receipt is fabricated for an email that was not sent.

The expected remote branch is deleted only for a verified merged PR and only after it is known to
belong to the owned task. The local worktree cleanup is restricted to the expected path and branch
and refuses symlinks, dirty trees, active rebases, conflicts, or unknown paths. It also preserves
ignored setup output and clean local-only commits. Ignored output is archived intact before safe
worktree removal, rather than discarded or permanently blocking routine cleanup. Closed-PR cleanup
requires accessible PR commit history. Known owned isolated resources may remain preserved without
blocking terminal release; unknown identity, execution or pending effects cannot. Required terminal
moves and comments must be verified before the next task. An unknown comment outcome remains pending
even when the card already appears in its destination list.

A verified terminal Trello outcome is separate from removing local artifacts. Inspect the validated
`terminal-resource-cleanup` compatibility record in the canonical attempt JSON for `pending`,
`removed`, `preserved`, or `retryable-failure`, its reason, attempt count, retry time and archive
plan. `removed` means the worktree and local branch were removed; archived ignored output may still
exist. Older terminal attempts without this record are eligible for the same idle reconciliation
when their original resource ownership and stopped-writer proof remain verifiable.

New ignored-output archives move by atomic rename to
`<worktreeRoot>/.cleanup-archives/<attemptId>/<original-relative-path>`, outside the task worktree
but on its volume. Context/state can remain on a separate volume without changing configured paths.
The durable plan records its archive root and device/inode identities before moving anything.
Restart reuses that destination and reconciles completed moves. Older populated plans without an
archive root retain their original `<contextRoot>/cleanup-archives/<attemptId>/` location; data is
not relocated. Missing identities, collisions, symlinked ancestors, changed source identity or an
unsupported custom cross-mount layout preserve the remaining resources and report a cleanup problem.
Unknown ignored files are preserved too: `.gitignore` is not authority to delete data. Archives are
private retained data, outside automatic log/context retention; inspect them before any manual
disposal. This releases Git resources, not necessarily disk space.

Between task writers, the service revisits at most one due terminal attempt per idle project poll,
with a minimum 60-second interval and at most three cleanup attempts total across restarts. It does
not republish an old attempt as active, dispatch engineering work, repeat terminal Trello effects or
touch an active task. Closed-PR retries recheck accessible implementation history. After exhaustion,
the outcome is `preserved` with `retry-limit`; inspect and resolve the recorded blocker manually. An
explicit interrupted/unshipped-work preservation fence is never automatically overridden. Terminal
synchronization and safe project release remain independent of retained artifacts.

## Additive maintenance and legacy rewrite fences

Current maintenance merges the pinned target commit into the existing published task branch,
retaining previous commits and the same PR. Persisted provenance, pre-dispatch file/index baselines,
expected merge parents/tree and exact remote head establish recovery. An accepted merge or push is
observed rather than repeated. Unknown execution or remote acceptance retains ownership and explicit
reconciliation; an absent branch never authorizes recreation after human closure.

Unrelated staged output and unknown local-only commits are not automatically included. Refusal
retains the queue's recovery identity so safe maintenance can resume after the blocker is resolved.
Unstaged excluded setup output is retained byte-identically. Conflict assistance is bounded and uses
the primary task session; no-op or exhaustion preserves the unresolved merge rather than staging
unchanged markers. Manual resolution does not authorize shipping unrelated index changes: preserved
non-conflict and pre-merge baselines are rechecked on recovery.

Legacy rebase/continue and force-with-lease paths remain disabled, including apparently unpublished
conflicts. Preserve their maintenance records, worktrees, backup refs, rewritten objects,
dirty/unshipped changes and remote history for operator reconciliation. Ordinary initial publication
requiring no history rewrite remains supported. Do not blindly retry uncertain pushes or reset,
abort, clean or discard preserved work.

A legacy `attention-required` record without a persisted `terminalFailure` cannot be automatically
moved to Failed or discarded. Polling now logs the blocked condition once per process without
emitting the same Attention Required email every 15 seconds; its queue event and files remain intact
for explicit operator recovery. This is **not automatic restoration** of an existing dirty
publication worktree: inspect its Git status, trusted commit, and persisted task state before
deciding how to resume or salvage the PR.

## Failed, unpublished PR maintenance and removed tasks

Legacy maintenance records of every status are treated conservatively. Status labels, missing remote
branches, and OPEN-only PR lookups do not prove that a clean local rewrite was shipped or never
published. Do not cancel, retire, retry, or clean up records, refs, objects, publication intents,
handoffs, or worktrees automatically. Read-only PR observation and independently verified terminal
reconciliation may continue; any legacy maintenance artifact causes terminal cleanup to preserve the
local worktree and related evidence.

A queued or interrupted terminal-PR mutation may outlive its Trello card. If that card is absent
from the Human Review list, polling verifies the exact PR by its stored number, URL, original task
ownership, base and head identity, and terminal state. Only then can it complete the orphan event
**without recreating or moving the missing Trello card or deleting the worktree**. A mismatch or
unavailable authoritative PR evidence remains blocked with a diagnostic rather than being guessed.

These safeguards do not authorize retiring an ambiguous push, live owner, active conflict, or
unknown repository mutation. Preserve state and seek operator recovery in those cases.

## Prepared publication conflicts

A legacy active conflicted rebase may have a persisted handoff below the configured worktree root:

```text
.orchestrator/prepared-conflicts/<project-id>/<card-id>.json
```

The handoff and conflict worktree are preserved without abort, reset, cleanup, removal, recreation,
or OpenCode continuation. No automatic publication or recovery of that legacy rewrite is attempted.
The affected task remains blocked until an operator reconciles history. A malformed handoff, missing
remote branch, or apparent completed rebase is not proof that automatic continuation is safe.

## Deliberate retry and operator actions

For a reconciled failed task, move the card to `Ready for Agent` to request a fresh attempt. No
internal-file edits are needed. The new attempt uses the latest fetched default branch, current card
and attachments, and fresh session/progress state. Earlier unfinished code, worktrees, execution
records and logs remain isolated under their old attempt identities; they are not automatically
incorporated. A deliberately requeued closed PR follows the same rule: rejected code is historical
context, not accepted implementation. Cards left in `Failed` do not automatically retry.

Read resource paths from the attempt record when inspecting newer attempts. Card-only path examples
below describe older attempts; subsequent attempts use `<card-id>--<attempt-id>` in the worktree and
branch names. Keep the original resource identities when recovering an existing attempt rather than
guessing or renaming them.

Automated failures move a card to `Failed` only after that Trello transition succeeds. Failure
comments provide the category, reason, and deliberate retry instruction. Move a card from `Failed`
to `Ready for Agent` only when intentionally requesting a new pass. Normal polling never retries
`Failed` cards automatically.

If Trello or GitHub returns a retryable transient error, owned active work retains its last verified
checkpoint and paced dependency wait. It resumes automatically after safe readback; a Ready move is
not required merely for a service outage. For a retained legacy reconciliation block only, an
exhausted card-scoped block is released by moving the affected card from its recorded reconciliation
list to `Ready for Agent`; a cardless project-level block requires resolving the external problem
and restarting the worker. Authentication, malformed responses, unknown persisted data, or
unsupported state are not treated as transient success.

An unreadable GitHub recovery-snapshot response remains an explicit, paced read-only wait, not a
successful check or permission to replay a write. Work resumes only after a complete snapshot
verifies the task's external and local identities. Older idle open-PR tasks escalated solely for a
GitHub read-contract failure can re-enter this reconciliation from their preserved canonical CI or
Human Review checkpoint after an upgrade, provided no writer or external effect remains unresolved.
Other attention blockers, missing PR identity, and uncertain active processes are not cleared by
this recovery path; a newly detected worktree or history conflict remains paused.

When investigating an `Attention Required` card, compare the durable record/queue with Trello list
history, PR state and head, worktree branch/head/status, trusted commit, primary session, complete
CI evidence, and unresolved feedback. Do not start a second task in the project while the current
task has ambiguous ownership. Contact a human when the available evidence does not establish a safe
deterministic continuation.

### Recovery under the normal service

Startup and polling use the same project lease and canonical attempt as normal execution. A
retained, previously persisted external PR association can resume after rechecking the merge
identity, equivalent implementation, CI, card membership and original processes. A patch or branch
name alone cannot establish an external association. A legacy Ready event labelled `completed`
cannot prove that it never started; those ambiguous events stay blocked. Older initial-session
attempts resume only when retained execution and session evidence establish a safe outcome. Existing
scoped startup attestations remain readable for compatible historical state; new assertions are not
accepted.

New initial-session dispatches persist a unique `--title` correlation intent, then bind execution
identity before spawning, and finalize process evidence even when the event stream is malformed.
Startup verifies the CLI supports `--title`. Polling automatically reconciles persisted `creating`
and `ambiguous` initial creation before general task recovery:

- Verify the original card, project queue, worktree and branch ownership before resuming anything.
- Recover the original session from finalized process/result evidence or the persisted correlation
  title and complete session inventory, only after process-tree termination is established.
- Reuse a hashed completed planning result instead of repeating its OpenCode dispatch. A known lost
  session enters the existing context-reconstruction protocol; its recovered planning output is
  retained in reconstruction history rather than replaced with context-free work.
- If advisory output is unavailable or corrupt, preserve it without replaying or declaring it valid;
  a separately verified stopped original session can reacquire advice without creating another
  session or treating the missing advice as a primary execution failure.
- Retry a conclusively stopped creation with no surviving session, or a new intent proven never
  dispatched. Genuine startup failures, including conclusive pre-dispatch failures, retain the
  existing three-failure allowance; provider outages do not consume it. Exhaustion uses verified
  Failed move/comment handling before project release.
- Unknown termination, incomplete session inventory, contradictory identity/process evidence or
  legacy missing provenance retain ownership in an explicit wait with paced rechecks. Attention
  reporting is deduplicated after repeated inconclusive checks. These are evidence-dependent waiting
  conditions, not an absorbing internal attention state or permission to create a duplicate session.
  Missing PIDs, elapsed time, and a negative immediate read are never stopped-process proof.

When authoritative evidence becomes available, a later poll resumes automatically. If an old lost
supervisor cannot supply termination proof, the service retains an explicit blocker. Restore the
original evidence if available; PID absence, a restart or manual state edits are not substitutes.

For an imported legacy `attention-required` implementation without terminal-failure proof, an
explicitly authorized move to Failed can retire the matching legacy queue event after identity/owner
checks, but does not invent canonical terminal evidence or guarantee project release. Preserve
original work and seek explicit reconciliation when canonical proof is missing. Do not use stale
pre-import JSON files as current authority or move the card repeatedly between lists to bypass that
fence.

Current genuine primary failures use bounded recovery (three verified genuine failures per semantic
operation), then automatically reconcile Failed and its comment before release when no PR exists.
Outages and reconstruction have separate accounting; a nonzero validation result is not a primary
crash. An open PR instead retains ownership and a recoverable operational blockage. Normal recovery
and deliberate retries never require internal-file edits. Unsupported or ambiguous state that cannot
be established safely stays preserved for operator/support resolution rather than receiving a
destructive generic reset command.

Live qualification on 2026-11-14 delivered
[PR #229](https://github.com/emilhornlund/agent-orchestrator/pull/229) through Human Review and
reconciled CI, including original-session reuse and a restart during validation. Its initial startup
blockage required operator assistance. Interrupted-creation failure injection and the automatic
reconciliation cases above are qualified with local durable-state fixtures and simulated external
boundaries; arbitrary supervisor loss and real service outages are not claimed universally
qualified.

### Completed refinement housekeeping

A verified `refined` attempt has no pull request. Its owned worktree and branch are cleaned up by
idle project housekeeping, after the final Backlog readback and terminal release, rather than by the
still-active refinement workflow. This also discovers already-completed attempts that previous
versions left behind with an `ignored-output` cleanup warning; no card movement or state reset is
required. Setup and OpenCode refinement are not run again for housekeeping.

Cleanup requires retained proof that setup and analysis stopped, verified task ownership, no active
competing task writer, and branch history preserved on the accepted default-branch ref. Ignored
output is **archived, not deleted**, using the existing durable rename plan under
`<worktreeRoot>/.cleanup-archives/<attemptId>/`. This directory stays on the worktree filesystem. Do
not delete the archive to silence a warning: it can contain valuable output as well as dependencies.
Tracked/untracked edits, local-only commits, unknown resources, conflicting archive destinations,
and missing or ambiguous execution evidence remain preserved.

Housekeeping retains its three-attempt limit and restart-safe recheck deadlines. Cleanup failure
does not undo successful refinement, move the card out of Backlog, rerun analysis, send another
completion notification, or prevent an independently eligible task from starting after terminal
release. Inspect `terminal-resource-cleanup` in the original attempt record for the cleanup status,
retry deadline, and archive plan. Preserve the same runtime, coordination, repository, and worktree
mounts when rebuilding and redeploying.
