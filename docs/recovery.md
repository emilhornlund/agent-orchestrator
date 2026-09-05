# Recovery

[README](../README.md) | [Workflow](workflow.md) | [Configuration](configuration.md) | [Operations](operations.md)

This page is the canonical recovery guide. Reconciliation is deliberately conservative: it uses recorded workflow evidence
and existing GitHub and Git artifacts instead of guessing what an interrupted task meant to do.

## Recovery principles

The orchestrator reconciles Trello state with Git and GitHub on every project polling cycle, before claiming another card.
Only one task may be active for a project. If the evidence identifies more than one recoverable active card, processing for
that project is blocked until the ambiguity is resolved.

Do not mark an interrupted card successful or failed just because the process stopped. Inspect these artifacts first:

- Trello list-transition history for the card;
- the expected worktree at `<worktreeRoot>/<trello-card-id>`;
- the expected local and remote branch `agent/<trello-card-id>`;
- Git status, commits, and the branch's changes relative to `origin/<defaultBranch>`;
- the expected GitHub pull request and its review state;
- the prepared-conflict handoff at `<worktreeRoot>/.orchestrator/prepared-conflicts/<project-id>/<card-id>.json`, when present;
- the card context at `<contextRoot>/<project-id>/<card-id>/`, including `attachments.json` and `attachments/`, when
  configured; and
- the per-card session log, when present, at `logs/sessions/<sanitized-project-id>/<sanitized-card-id>.log`.

Each exhausted Trello or GitHub reconciliation is also recorded outside Git at
`<contextRoot>/<project-id>/reconciliation-block.json`. The record contains the project and affected card identity,
operation, recorded reconciliation list, failure category and reason, retry key, recovery condition, and notification
identity. It is runtime state, not card context or repository state, and must remain below the configured `contextRoot`.

Before normal startup reconciliation, the service cleans only stale temporary files from the three persisted-state writers. It
recognizes `<worktreeRoot>/.orchestrator/review-maintenance/<project-id>/<card-id>.json.<process-id>.tmp`,
`<worktreeRoot>/.orchestrator/prepared-conflicts/<project-id>/<card-id>.json.<process-id>.tmp`, and
`<contextRoot>/<project-id>/.reconciliation-block.json.<process-id>.<unique-suffix>`. A candidate is removed only when it is a
regular file and its recorded writer process has stopped; a file from an active writer is retained. Missing directories and
concurrent disappearance are harmless. Authoritative state, including malformed state retained for diagnosis, directories,
symbolic links, unknown files, logs, card attachments, repositories, worktrees, and other temporary files are never removed by
this cleanup. Failures are logged with the path and reason while other configured projects continue startup.

Preserve the task worktree, branch, session log, and diagnostic information while investigating. Do not delete an unknown
worktree or discard agent changes as a first response. Restarting the service runs the normal reconciliation flow.

Card context is retained independently of repository and worktree cleanup. A successful preparation leaves the current
manifest and materialized uploads available for a later retry, after removing stale regular files claimed by the prior
manifest. It never removes unknown or unrelated files during reconciliation. A failed preparation preserves the last
successfully published manifest and its materialized files, while partial new downloads are removed. Scheduled context
retention removes an expired card context directory as a unit only after its retention cutoff, and never while that card is
actively being processed.
Operators may remove only known card-context data below the configured `contextRoot` after the card no longer needs a retry or
diagnosis, and must not remove unknown files outside that root.

## Interrupted runs and restart

`SIGINT` and `SIGTERM` request coordinated shutdown. Cancellation is cooperative rather than universal: Trello requests,
OpenCode sessions, poll-time setup commands, and SMTP delivery honor the abort signal, but Git operations and GitHub CLI calls
do not currently receive it. An in-flight fetch, rebase, push, or `gh` command may therefore finish after shutdown is requested.
Shutdown does not mark cards successful, advance Trello state, delete recoverable worktrees, or discard agent changes. After
an intentional or fatal stop:

1. Inspect the Trello transition history, worktree, branch, pull request, and session log for the affected project.
2. Resolve any Git conflict or external failure in the preserved task artifacts without changing unrelated worktrees.
3. Restart with `yarn dev` and allow the next polling cycle to reconcile the project. Startup restores an unresolved
   reconciliation block without launching the exhausted operation or sending another alert for the same failure.
4. Move a card to `Ready for Agent` only when deliberately retrying it; do not use `Backlog`, `Failed`, or `Done` as an
   automatic retry queue.

Fatal startup failures, uncaught exceptions, and unhandled promise rejections are logged as diagnostics and cause exit code
`1`. Their recovery still depends on the same deterministic artifacts. See [Operations](operations.md#shutdown-and-fatal-errors)
for runtime behavior.

## `Working` card reconciliation

A `Working` card is recoverable only when its latest recorded transition into `Working` proves one of these paths:

- `Ready for Agent` to `Working`, with the expected non-symbolic directory worktree on the exact
  `agent/<trello-card-id>` branch; or
- `Human Review` to `Working`, with an expected open pull request that has actionable requested changes.

Working reconciliation never creates a worktree. If the card has no recorded transition, was moved manually from another
list, lacks the required workflow label, or has no valid expected worktree for a `Ready for Agent` transition, it is corrected
to `Backlog`. Existing stale branches or worktrees do not make an otherwise unrecoverable card valid.

For a card that came from `Ready for Agent`:

- Without an expected open pull request, the implementation or refinement workflow resumes from its existing worktree.
- A refinement card with an unexpected pull request is corrected to `Backlog`.
- An implementation card with an open pull request and actionable requested changes resumes the feedback workflow.
- An implementation card with an open pull request but no actionable requested changes is moved to `Human Review` when
  `autoMerge` is disabled; when it is enabled, the pull request is merged and the card is completed in `Done`.
- An enabled implementation card with an already merged pull request is completed in `Done` without another merge attempt.

For a card that came from `Human Review`, the expected open pull request and actionable requested changes are both required
to resume feedback implementation. Otherwise the card is corrected to `Backlog`.

If more than one recoverable card is in `Working`, the project is blocked. No card is selected automatically, and an enabled
`Attention Required` notification identifies the affected card IDs and available session logs.

## `Human Review` reconciliation

For each card in `Human Review`, the orchestrator checks the expected `agent/<trello-card-id>` pull request:

| Evidence                                                                          | Reconciliation                                                                                                                                      |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull request is merged                                                            | Delete the merged remote branch when present, move the card to `Done`, mark it complete, remove the session log, and attempt terminal local cleanup |
| Pull request is closed without merge                                              | Move the card to `Backlog`, add a Trello comment identifying the closed pull request, and attempt terminal local cleanup                            |
| Pull request is open with current-head requested changes                          | Move the card to `Working` and resume feedback implementation                                                                                       |
| Pull request is open without current-head requested changes                       | Leave the card in `Human Review`; record maintenance state and automatically maintain an eligible clean stale branch                                |
| Pull request is open with recognized `UNKNOWN` mergeability or merge-state status | Leave the card in `Human Review`; start no maintenance and retry the GitHub state read through the bounded three-attempt reconciliation policy      |
| Prepared-conflict handoff is present                                              | Leave the card in `Human Review`; expose `prepared-conflict` and block project processing until remediation completes or the state is resolved      |
| No expected pull request                                                          | Correct the card to `Backlog`                                                                                                                       |

More than one active card in `Human Review` is an ambiguous project state. The active-state check runs before terminal cards
are transitioned, so the project is blocked, no active card is selected, and no terminal card is transitioned in that cycle.
Merged or closed cards remain available for reconciliation on the next cycle after the ambiguity is resolved.

Maintenance applies only to an open pull request in the configured repository whose head is exactly `agent/<trello-card-id>`,
whose base is the configured default branch, whose state is `behind` or `conflicted`, and which has no actionable requested
changes on its current head. A recognized `UNKNOWN` mergeability or merge-state status is transient unresolved data: it leaves
the card and branch unchanged and uses the existing card-scoped GitHub reconciliation retry path, including its three-attempt
bound and backoff. Recovery before exhaustion resumes normal classification; persistence through exhaustion blocks the project and
emits the existing `Attention Required` diagnostic. Incomplete, malformed, or unsupported authoritative data, a changed pull
request, a closed or merged pull request, an unexpected branch, or current-head requested changes leaves the card and branch
unchanged without a transient retry.

For an eligible branch, reconciliation revalidates the pull request, resolves the authoritative remote task SHA with `ls-remote`,
and prepares or reuses only `<worktreeRoot>/<trello-card-id>`. It fetches the latest default branch there and attempts a normal
rebase. When the worktree is new, its effective state changes, or setup has not completed for that state, the configured
`repository.setupCommand` runs before `repository.validationCommand`. Successful setup and validation state is retained with the
expected worktree and repository SHAs, so an unchanged prepared worktree does not repeat either command. A deterministic
validation failure is retained with the same state identity; later reconciliation leaves the card in `Human Review` without
repeating validation or its attention notification. A changed pull-request head, changed rebase result, recreated worktree, or
changed command configuration invalidates the record and retries. The existing pull request is retained and the card stays in
`Human Review`; no OpenCode session, new pull request, replacement, merge, or Trello transition is involved. A branch already at
the current default tip is a no-op and is not rebased, set up, validated, pushed, or reported as a successful maintenance update.

Eligible long-running maintenance adds a managed section to the existing pull request description, bounded exactly by
`<!-- agent-orchestrator-status:start -->` and `<!-- agent-orchestrator-status:end -->`. Its supported phases are rebasing onto the
latest configured default branch, resolving merge conflicts, running repository validation, and updating the remote task branch,
represented by `rebasing`, `resolving-conflicts`, `validating`, and `updating-remote`; `failed` requires human attention. The
section is removed after successful maintenance. If automatic Git maintenance fails, it is replaced with the `failed` status. The
orchestrator owns only the content inside the markers and preserves all other description text.
Each update reads the latest description immediately before writing, skips an identical result, and never creates a second section.

Malformed marker structure, including missing, reversed, or duplicate markers, fails closed: the description is left unchanged and
the pull request and card receive an actionable normal attention diagnostic. A description read or write failure is secondary to
Git recovery, is logged with the pull request and card, and does not reset, abort, clean, overwrite, or otherwise alter the task
branch, worktree, handoff, or other Git artifacts. It must not be reported as a successful status update.

The lease protects against concurrent remote updates. If the branch changes or disappears after the authoritative lookup, the
single force-with-lease update is rejected and is not retried with another SHA. Fetch, worktree, rebase, validation, remote lookup,
or lease failures preserve the card, pull request, branch, and worktree. A non-zero validation command prevents the push.

A rebase conflict is prepared only when Git reports both an active rebase and one or more conflicted paths. In that case the
orchestrator writes a validated handoff at
`<worktreeRoot>/.orchestrator/prepared-conflicts/<project-id>/<card-id>.json` and exposes the Human Review card as
`prepared-conflict`. Its fields are `projectId`, `cardId`, `taskBranch`, `defaultBranch`, `expectedRemoteTaskSha`,
`conflictedPaths`, and `rebase` (`backend`, `headName`, `onto`, `originalHead`, and available step metadata). The task branch
SHA is captured with authoritative `ls-remote` before the rebase attempt, so it is not inferred from a rebased or local value.

Retry validation treats the task branch, expected worktree and repository, backend, `headName`, `onto`, and `originalHead` as
the prepared rebase identity and keeps them strict. It accepts the recorded conflict step or forward progress to a later
conflict stop in that same rebase, rejects regressed or out-of-range progress, and requires present `totalSteps` values to agree.
Missing optional progress metadata remains acceptable. A completed rebase proceeds through the normal completion and publication
verification path.

While this record exists, it is the durable active-remediation lock for the project. Reconciliation returns the same state after
restart, does not start a second rebase, and does not process another Working or Ready card. The card stays in Human Review.
The conflicted worktree, branch, conflict markers, and Git rebase metadata remain available; preparation performs no abort, reset,
clean, removal, recreation, validation, push, pull-request mutation, or merge. The project worker starts dedicated remediation in
that existing worktree using the configured remediation-stage OpenCode model and variant. The prompt is limited to the original
card intent and active conflicts, and explicitly covers repeated conflict stops, staging resolutions, rebase continuation, and
validation. After the rebase is safely complete, the worker verifies the Git state, runs setup when the retained preparation state
does not match, reruns configured validation, confirms that the authoritative remote task SHA is still the handoff SHA, and performs
one exact force-with-lease update. It removes the handoff only after that update succeeds. The existing pull request is retained, the
card stays in Human Review, and normal reconciliation can observe the updated branch. It must not remove the record merely to make
polling proceed.

An OpenCode failure, timeout, permission denial, unresolved rebase, validation failure, malformed or missing remote SHA, concurrent
remote change, or lease rejection leaves the handoff, worktree, branch, and pull request available for diagnosis. The failure is
annotated with the existing session log when available and escalated through the normal attention path. Remediation retries are
bounded; after the worker retry threshold the project remains blocked and does not launch the same session on every poll. While
blocked, the worker periodically performs only the local handoff and Git conflict-state checks. It keeps the project blocked while
the handoff or underlying conflict remains unresolved, and emits no repeated attention alert for that unchanged condition. Once a
valid handoff's clean completed rebase is verified, the worker clears only the project block and resumes without a restart. The
next cycle routes the existing worktree through prepared-conflict remediation; local completion does not remove the handoff or
establish publication. A missing or invalid handoff remains blocked until the state is repaired or the worker is restarted.

A Git command error alone is not sufficient evidence of a prepared conflict. If active rebase inspection fails, the rebase is
active without conflicted paths, the handoff cannot be persisted, or remote/PR/worktree setup fails first, normal failure and
`Attention Required` diagnostics are used and Trello is not advanced. Preserve the worktree and inspect Git state, correct the
external problem, and retry only through the documented workflow; do not manually reset or clean an unknown or still-uninspected
conflict.

Trello and GitHub read failures during reconciliation are handled separately from card failures. Trello HTTP 500, 502, 503,
and 504 responses, rate limits, timeouts, and temporary connectivity errors leave the card in its current list with no
missing-card inference, corrective comment, or workflow transition. The same Trello classification applies to card discovery,
transition history, labels, comments, content updates, and attachment metadata/download requests. Each project records the
attempt in its running worker and logs the project, card when known, operation, attempt number, classification, and safe error
context. The next project cycle retries the operation; three consecutive failed attempts are the deterministic bound, after
which the operation is blocked, the block is durably written to `<contextRoot>/<project-id>/reconciliation-block.json`, and the
existing project-level diagnostic and `Attention Required` escalation is emitted. A blocked card operation is not called again
during normal polling or restored at startup. After resolving the external failure, move the affected card from its recorded
reconciliation list to `Ready for Agent`; the worker observes that explicit recovery transition, removes the block and clears the
operation's retry state, and resumes normal processing. A project-level failure with no affected card remains blocked until the
external problem is resolved and the worker is explicitly restarted; restart is the operator recovery condition for this case,
not a Trello card transition. Notification identity is restored with the block, so restart does not duplicate an
`Attention Required` alert for an unchanged failure. Authentication, configuration, malformed-response, not-found, and other
non-transient failures continue directly to the normal failure diagnostics.

The block file is validated before it is used. Invalid JSON, missing or blank required values, unsupported operation or recovery
condition values, wrong optional-field types, and project/card identity mismatches fail closed: the project does not poll or
launch the exhausted operation, the file is retained unchanged, and an actionable `Attention Required` diagnostic is emitted.
Other project workers continue independently. A failed block write or removal is reported and does not turn an unresolved or
uncertain external operation into a successful recovery.

The three authoritative orchestrator JSON stores, including the reconciliation block above, prepared-conflict handoffs, and
review-maintenance records, have the same fixed 1 MiB file-size guard. The service checks the file size before reading or parsing
its contents. An oversized file is treated as malformed persisted state: the affected path and size-limit failure are included in
the concise diagnostic, but persisted contents are not. The original file is preserved for investigation. Reconciliation keeps
its malformed project-blocking path, while prepared-conflict and review-maintenance records keep their existing recovery and
maintenance error paths; missing or ordinarily malformed files retain their existing behavior and no workflow state advances.

If a Trello mutation fails transiently, its requested transition or update is unconfirmed. The orchestrator does not move the
card to `Failed` merely because the request was unavailable. It preserves the last known workflow state and lets a later
reconciliation read Trello transition history and card state before retrying an uncertain move or resuming work. Shutdown
cancellation is not retryable and does not cause new work or state transitions.

An already-absent `agent/<trello-card-id>` remote branch is a successful merged-card cleanup outcome. Reconciliation skips the
delete command when the initial check finds no branch, and also accepts Git's missing-remote-ref result when the branch
disappears between that check and the delete attempt. Other Git or GitHub cleanup failures remain fatal and leave the card
available for failure diagnostics rather than moving it to `Done`.

After the merged `Done` transition and completion notification handling, or after the closed-PR `Backlog` transition and
comment attempt, reconciliation makes a separate best-effort attempt to remove only `<worktreeRoot>/<trello-card-id>` and
`agent/<trello-card-id>`. An absent local worktree or branch is harmless. A cleanup failure is logged as a warning containing
the project, card, expected paths, and Git error; it does not undo the successful terminal transition or notification state.

Cleanup preserves recovery state when the expected path is symbolic, outside the configured root, nested or unknown, on an
unexpected branch, dirty, has unmerged paths, or has an active rebase. A prepared-conflict handoff also protects its local
state until recovery is no longer required. Shutdown cancellation does not delete local state. Inspect and resolve these
preserved artifacts before any deliberate retry; do not remove arbitrary worktrees or branches.

A closed pull request without merge evidence is treated as a deliberate rejection or cancellation. Reconciliation moves the
card to `Backlog`, adds a comment stating that the pull request was closed without being merged and including its URL, and does
not send the `failed` event. If the move to `Backlog` fails, reconciliation preserves the diagnostic failure and does not add
the cancellation comment. If the move succeeds but the comment fails, the card remains in `Backlog` and the comment failure is
logged.

An enabled implementation normally does not enter `Human Review`. A card already in that list continues through the existing
human-review reconciliation path, so enabling `autoMerge` does not reinterpret an operator-managed review card.

## Deliberate retry from `Failed`

To retry, move the card from `Failed` to `Ready for Agent`. That transition is the explicit operator instruction used by
failure comments and failure emails. The orchestrator does not automatically retry `Failed` cards.

When the expected worktree and `agent/<trello-card-id>` branch remain valid, the retry reuses them. A clean worktree whose
branch has tracked committed changes relative to `origin/<defaultBranch>` is treated as completed implementation work. The
retry skips setup, implementation, review, remediation, and commit, then resumes publication.

An existing worktree or branch alone is not proof of completed implementation:

- A branch at its base, a branch with no tracked committed changes, or a dirty worktree follows the normal implementation
  path.
- Uncommitted work is preserved for OpenCode to inspect rather than treated as a completed implementation.
- Before publication, the retry fetches and rebases onto the latest `origin/<defaultBranch>`.
- A rebase conflict or an existing remote branch that would require a non-fast-forward update stops publication and preserves
  the task worktree and branch for diagnosis and another deliberate retry.

If the worktree or branch is not valid for recovery, the normal claim and worktree preparation rules apply. Reconciliation
does not create worktrees for arbitrary `Working` cards.

## Failure handling

For an automated card failure, the orchestrator attempts to move the card to `Failed`, then adds a Trello comment containing
the failure category, reason, and deliberate retry instruction. A failed move does not become a successful transition, and the
primary error plus failure-handling outcome are preserved for project-level diagnostics. If the move succeeds but the comment
fails, the card remains in `Failed` and the comment error is logged.

If a pull request was published but the move to `Human Review` failed, the card is left in a published `Working` state for
reconciliation rather than being moved to `Failed` without evidence. If a project poll or reconciliation fails before a
single card's failure handling completes, the project-level `Attention Required` path can report the affected cards and
session logs; transient Trello and GitHub failures are the exceptions described above and are retried before escalation. No
transient attempt moves a card to `Failed` or is treated as evidence that its workflow state is invalid.

If automatic merging succeeds but the move to `Done` fails, the card is left in `Working` with the merged pull request and
the preserved worktree and session log. The next reconciliation observes the merged pull request, moves the card to `Done`
with `dueComplete: true`, sends the `done` event when enabled, and adds the auto-merge summary without merging the pull
request again. Merge failures leave the card available to normal failure diagnostics and preserve the task artifacts; no
success summary or completion email is sent before both the merge and `Done` transition succeed.

The implementation workflow does not automatically remove a failed task worktree or branch. Successful publication and
successful refinement have their normal cleanup paths, while failed-card session logs remain available until log retention
removes them. See [Operations](operations.md#logging-and-retention).
