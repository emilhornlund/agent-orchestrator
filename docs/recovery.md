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

## Failed, unpublished PR maintenance and removed tasks

A deterministic PR-maintenance quality failure (including an invalid review
response after format correction) must not indefinitely own the project queue.
On the next poll, a failed maintenance mutation can be retired only when its
persisted operation is unowned, the prepared commit identity matches the failed
quality evidence, and **no publication intent exists**. The maintenance record
is marked `cancelled` before the matching queue mutation is completed. A
restart between these writes reconciles the same event without replaying work.

The prepared local rebase, its worktree, and its persisted evidence are
preserved. A cancelled, failed maintenance review is not treated as passing
and is not automatically rerun or published. A subsequent closed PR with
such an unpublished rebase can transition its extant Trello card to Backlog,
but must preserve the worktree for deliberate operator cleanup.

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

### Retire a legacy terminal failure without editing runtime state

For a task produced by a release that left `phase: attention-required` and a failed active implementation event, the queue is
intentionally still owned. The supported retirement is an explicit, audited Trello move to `Failed`; the next poll verifies the
project/card/operation/expected-branch identity, verifies that the prior worker no longer owns the queue, and releases only that
matching event. The task record, plan, session binding/log, worktree, branch, queue history, and all working-tree changes remain in
place. No retry is started by this procedure.

Before authorizing that Trello move, an operator must:

1. Stop or pause the orchestrator worker for this project. Confirm the queue's `ownerPid` is no longer alive (`kill -0 <pid>` must
   fail); if it succeeds or its outcome is unclear, stop and wait. Do not use a second worker to recover it.
2. Verify the task record and active queue event identify the configured project, the exact Trello card, the same operation key,
   and `agent/<card-id>`. Verify Trello currently has that exact card in `Working`. If any identity differs, stop.
   Read-only checks against the configured context root can establish the persisted identity:

   ```sh
   jq -e --arg project "$PROJECT_ID" --arg card "$CARD_ID" --arg branch "agent/$CARD_ID" \
     '.projectId == $project and .cardId == $card and .expectedBranch == $branch and .phase == "attention-required"' \
     "$CONTEXT_ROOT/task-executions/$PROJECT_ID/$CARD_ID.json"
   jq -e --arg card "$CARD_ID" \
     '[.events[] | select(.cardId == $card and .status == "failed")] | length == 1' \
     "$CONTEXT_ROOT/task-mutation-queues/$PROJECT_ID.json"
   ```

   Compare the selected event's `operationKey` to the task record's `operationKey` and verify its `activeEventId` matches its
   `eventId`. These commands only read state; never use `jq` to rewrite it.

3. Verify the worktree resolves to `<worktreeRoot>/<card-id>` and is on `agent/<card-id>`. Preserve the current state before
   proceeding:

   ```sh
   tar -C "$CONTEXT_ROOT" -czf "$BACKUP_DIR/context-before-retirement.tgz" task-executions task-plans task-mutation-queues
   git -C "$WORKTREE" status --short --branch
   git -C "$WORKTREE" diff --binary > "$BACKUP_DIR/worktree.patch"
   git -C "$WORKTREE" ls-files --others --exclude-standard -z > "$BACKUP_DIR/untracked-files.list"
   ```

   Copy every listed untracked file and any relevant ignored/untracked data into the backup directory. Do not clean, reset, stash,
   or remove the worktree.

4. Inspect local commits (`git -C "$WORKTREE" log --oneline --decorate -10`), remote branch state
   (`git ls-remote origin "refs/heads/agent/<card-id>"`), and GitHub PRs
   (`gh pr list --head "agent/<card-id>" --state all`). Confirm whether each result is absent or belongs to this task; unknown or
   mismatched commits/branches/PRs mean stop and escalate. Record the results with the incident.
5. Obtain explicit operator authorization to retire this failed attempt. Only then move the card once in Trello from `Working` to
   the configured `Failed` list. This Trello action is the authorization signal; do not edit the queue or task JSON.
6. Restart the project worker with the normal deployment/start command. For a local installation this is `yarn dev` from the
   repository with its normal environment loaded. Polling verifies the card is in `Failed`, checks the matching dead queue owner,
   and marks only that queue event completed. Confirm the event is no longer active and verify the task record/worktree still
   exist. A mismatch, failed lookup, or uncertain transition leaves ownership in place for investigation.

For newly recorded, confirmed nonzero implementation exits, polling performs the `Working` → `Failed` transition itself and
completes the mutation event only after Trello confirms `Failed`. A lost response is reconciled by checking the Failed list before
retrying the move. The durable task record and worktree are preserved in either case. To request a later deliberate retry, follow
the separate retry process only after the failed attempt has been retired and its retained work has been reviewed; never move a
card back to `Ready for Agent` while its old task record or queue identity remains unresolved.

Recovery has been tested only with local fixtures and mocked services. No live Trello/GitHub pilot, real OpenCode session restart,
or external API availability test has been performed.
