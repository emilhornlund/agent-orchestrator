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
task-executions/<project-id>/<card-id>.json       phase, owner, session, PR/head, evidence, repair state
task-plans/<project-id>/<card-id>.json             approved plan and independent verification
feedback-ledgers/<project-id>/<card-id>.json       stable feedback IDs, dispositions, and contextual reply state
task-mutation-queues/<project-id>.json             queued events and the single active mutation owner
<project-id>/reconciliation-block.json             exhausted transient Trello/GitHub reconciliation state
```

These versioned and revisioned files are authoritative runtime data, separate from the source checkout and task worktrees. Back
up the context root with the same care as other workflow state. A malformed, stale, or ownership-mismatched record is preserved
for diagnosis and blocks unsafe continuation.

Also inspect the expected worktree `<worktreeRoot>/<card-id>`, branch `agent/<card-id>`, Git status and head, trusted commit
record, authoritative Trello list/history, GitHub PR identity/head, and the per-card session log when present. Never delete an
unknown worktree or discard changes as a first response.

## Restart and task ownership

After restart, `pollProject` calls the unified task-session coordinator. It checks queue ownership and persisted task phase before
resuming any work. The primary session is verified with
`opencode session list --format json --pure --max-count 10000` from the owned worktree; its ID and directory must match the
recorded binding. Implementation, CI correction, and feedback remediation resume the exact stored session ID. The service never
substitutes a new session or uses implicit `--continue`.

A queued `Ready for Agent` claim resumes only when its persisted event identity and expected owned worktree/branch match the
card. An owned `Working` implementation resumes from its recorded phase only after validating task identity, setup state,
worktree, branch, head, session binding, and relevant trusted publication evidence. A trusted published commit can be reused;
recovery never creates a duplicate commit, push, or PR. Refinement events use the same project mutation queue and expected
`agent/<card-id>` worktree; ambiguous ownership preserves the queue and blocks subsequent mutations.

If a different live worker owns the queue, a second poll does not steal its event. A failed or uncertain event retains ownership
until a verified recovery; do not manually clear it to start another task. Exhausted validation, coverage, review, CI, or feedback
repair remains preserved for attention rather than being restarted by normal polling.

## CI waiting, failure, and repair

CI expectations come from available branch-protection rules and reliable static repository workflow contracts. Check runs and
commit statuses are observed for the exact persisted PR head. Conditional/dynamic workflow contracts, inaccessible policy,
empty expectations, delayed check registration, pending or queued jobs, cancelled/skipped/neutral results, and stale or malformed
observations cannot become a pass. If expectations are incomplete or uncertain, the task remains waiting/fails closed with an
explicit diagnostic; no repair attempt is consumed and auto-merge is prohibited.

Only a complete expected-check set with every expected check terminal can produce a failure result. All failures for that head
are collected together before the primary session is asked to repair. After each bounded correction the orchestrator reruns local
validation, configured coverage, independent review, safe publication, and complete CI observation against the new head. The
repair counter is persisted and finite. When the limit is reached, the PR and worktree remain available for a human; no new PR is
created.

## Feedback and replies

Review bodies, inline threads, and conversation comments are tracked by stable GitHub identity in the task ledger. New comments do
not erase earlier still-applicable unresolved feedback. Actionable items are resumed in the primary session and independently
verified against current content/head. A reply is published only after the correcting commit has been safely published and the
complete current-head CI evaluation passes. An uncertain send is reconciled by its stable marker before retrying; do not send a
duplicate reply manually. The service does not approve reviews, dismiss decisions, or resolve reviewer threads.

## Terminal pull requests

An authoritative merged PR moves its card to `Done`; a deliberately closed unmerged PR moves its card to `Backlog`. A persisted
terminal queue event owns the operation across external moves and cleanup. On restart, polling rechecks PR identity/state and
resumes the matching event. Repeated terminal transitions do not merge again or duplicate destination moves/comments. If
ownership, PR metadata, or a Trello move is uncertain, the queue and recovery information remain in place.

The expected remote branch is deleted only for a verified merged PR and only after it is known to belong to the owned task. The
local worktree cleanup is restricted to the expected path and branch and refuses symlinks, dirty trees, active rebases, conflicts,
or unknown paths. A cleanup failure preserves the terminal event so the operation can be retried without losing ownership.

## Prepared publication conflicts

A verified active conflicted rebase uses the persisted handoff below the configured worktree root:

```text
.orchestrator/prepared-conflicts/<project-id>/<card-id>.json
```

The handoff preserves task/base identity, trusted pre-rebase commit, target, conflicted paths, and rebase metadata. The conflict
worktree is not aborted, reset, cleaned, removed, or recreated automatically. Dedicated remediation runs in the same owned
worktree, and publication resumes only after the handoff and rebase are authoritatively verified. A malformed handoff, a rebase
error without an active conflict and conflict paths, failed remediation, or uncertain publication remains available for attention.

## Deliberate retry and operator actions

Automated failures move a card to `Failed` only after that Trello transition succeeds. Failure comments provide the category,
reason, and deliberate retry instruction. Move a card from `Failed` to `Ready for Agent` only when intentionally requesting a
new pass. Normal polling never retries `Failed` cards automatically.

If Trello or GitHub returns a retryable transient error, the worker retains the last known state and uses the existing bounded
reconciliation policy. An exhausted card-scoped block is released by moving the affected card from its recorded reconciliation
list to `Ready for Agent`; a cardless project-level block requires resolving the external problem and restarting the worker.
Authentication, malformed responses, unknown persisted data, or unsupported state are not treated as transient success.

When investigating an `Attention Required` card, compare the durable record/queue with Trello list history, PR state and head,
worktree branch/head/status, trusted commit, primary session, complete CI evidence, and unresolved feedback. Do not start a second
task in the project while the current task has ambiguous ownership. Contact a human when the available evidence does not establish
a safe deterministic continuation.

Recovery has been tested only with local fixtures and mocked services. No live Trello/GitHub pilot, real OpenCode session restart,
or external API availability test has been performed.
