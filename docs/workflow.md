# Workflow

[README](../README.md) | [Configuration](configuration.md) | [Recovery](recovery.md) | [Operations](operations.md)

This page is the canonical reference for the Trello and GitHub workflow. Each project has six configured Trello lists and
four configured workflow labels. The configured names are for people; the orchestrator uses the configured Trello IDs. See
the [configuration reference](configuration.md) for the corresponding keys.

## Lifecycle at a glance

Normal implementation follows this path:

```text
Ready for Agent
       |
       v
    Working
       |
       +-> isolated worktree, setup, implementation, review, remediation, commit
       |
       v
   Human Review
        |
        +-> merged pull request ----> Done
        +-> requested changes ------> Working
        +-> closed without merge ----> Backlog
```

Automatic merging is not supported. Configuration with `projects[].autoMerge: true` is rejected; omit the legacy setting or
set it to `false`. Only an observed human merge or unmerged closure ends the active PR workflow.

Refinement uses the same initial claim but returns the card to `Backlog`:

```text
Ready for Agent + Refinement -> Working -> Backlog
```

A refined card must be explicitly moved back to `Ready for Agent` before implementation. `Backlog`, `Failed`, and `Done`
cards are not automatically processed.

## Unified task lifecycle

Every project uses one durable task-session lifecycle. A Ready card is claimed only after ordered eligibility and label
classification, then serialized behind the project's single mutation owner:

```text
Ready for Agent -> Working -> advisory plan + independent plan feedback
  -> implementation in the persisted primary OpenCode session
  -> orchestrator validation + configured coverage + independent review
  -> trusted commit + existing/new PR publication
  -> discover expected checks + observe all exact-head check runs and commit statuses
       -> waiting/uncertain: preserve state; do not repair, reply, or merge
       -> complete failures: bounded same-session repair -> local gates/review -> same PR -> re-observe new head
       -> complete pass: remain active in Human Review
  -> Human Review: current actionable feedback -> Working -> same primary session -> advisory checks -> publish -> Human Review
  -> manually merged PR -> Done; deliberately closed PR -> Backlog
```

One primary OpenCode session ID is persisted per task and resumed for implementation, CI repair, and human-feedback remediation.
Independent plan and implementation reviewers use separate sessions. Planning,
plan review, local checks and implementation review are advisory, not publication
approval gates. The orchestrator executes configured checks and records their actual
results; meaningful safe implementation output is published even when those checks
fail or advisory steps are unavailable. Both normal and draft PRs move to Human
Review only after publication is verified. Failed, skipped or uncertain local
checks and material unresolved issues produce a draft with accurate disclosure.
AI reviewer approval is not required; the primary agent supplies substantive
dispositions for review concerns. None of these signals authorizes a merge.
Unsafe Git state, unknown writers and genuinely unrecoverable primary execution
remain distinct operational failures with preserved state. No manual check-name configuration is required. Local
mock tests cover the lifecycle; no live Trello/GitHub/OpenCode pilot has been performed. See
[Configuration](configuration.md#ci-expectation-discovery) and [Recovery](recovery.md#restart-and-task-ownership).

Local validation and coverage repair has a separate maximum, configured by
`opencode.remediation.validationMaxPasses` (default `2`). Its limit is persisted
before dispatch, the primary session may finish early, and an attempt that leaves
exact source content unchanged ends the cycle without rerunning unchanged checks.
Exhaustion proceeds toward publication with observed quality results; it does not
fail the task by itself.

Implementation-review improvement uses its own persisted `opencode.remediation.maxPasses`
maximum (default `1`), with the same early-finish and exact-content no-op rules.
Restart preserves both budgets and the original pending operation rather than
starting another cycle. Initial output is recorded in one descriptive commit;
unrelated setup changes remain preserved but excluded. Essential clarification
after examining the task/repository/attachments, or no meaningful task output,
produces an actionable verified `Failed` outcome without an artificial commit or
PR. A human can clarify and deliberately requeue the task later.

Descriptions include purpose, significant changes, orchestrator-observed checks,
outstanding issues and the Trello link, even when AI description generation fails.
Updates replace only the managed description region and preserve human text.
The same draft PR can become ready when current source-bound passing evidence and
recorded issue dispositions support it, no unresolved human requests remain, and
the open PR's exact published head and refreshed description are verified. Stale
or uncertain evidence cannot promote it.

Automatic CI expectations come from available branch-protection policies and static repository-owned pull-request workflow
contracts. Conditional jobs, dynamic matrices, unsupported workflow constructs, inaccessible policies, empty contracts, and
checks that have not appeared keep the result uncertain or waiting. A visible subset of passing checks is not evidence that the
expected set is complete. All failures in a complete set are supplied together to the bounded repair cycle; pending or uncertain
results do not consume repair attempts.

When polling resumes an owned `Working` card, the coordinator reconciles persisted phase, queue ownership, worktree/branch,
setup status, and primary-session identity before continuing. Validation/review uses persisted content-bound evidence, and
publication reuses only an exactly trusted commit. Missing or contradictory evidence is escalated without starting a second
implementation, commit, push, or PR.

## Trello lists

| List              | Purpose                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `Backlog`         | Tasks that are not currently queued for automated processing     |
| `Ready for Agent` | Tasks waiting to be claimed                                      |
| `Working`         | Tasks under automated implementation, refinement, or remediation |
| `Human Review`    | Tasks with a published pull request awaiting human review        |
| `Failed`          | Tasks that could not complete the automated workflow             |
| `Done`            | Tasks whose pull requests have been merged                       |

The list names themselves are not significant. At startup, every configured list must exist, be open, and belong to the
configured board.

## Workflow labels

| Label         | Purpose                                                    |
| ------------- | ---------------------------------------------------------- |
| `Refinement`  | Routes a task through refinement instead of implementation |
| `Feature`     | Classifies feature implementation work                     |
| `Improvement` | Classifies improvement implementation work                 |
| `Bug`         | Classifies bug-fix implementation work                     |

All four labels must exist on the configured board. Eligible cards in `Ready for Agent` are considered in the order returned
by Trello, from top to bottom, and the first eligible card is claimed regardless of workflow. A card is eligible for normal
implementation only when it has at least one of the configured `Feature`, `Improvement`, or `Bug` labels and has no future
start date. A card with no start date, or whose start instant has been reached, remains eligible. Future-dated cards are
skipped without being claimed and do not block a later eligible card; they become eligible automatically on a later normal
poll. Unlabelled cards are ignored without changing the relative priority of later eligible cards.

After the first eligible card is selected, `Refinement` takes precedence over implementation labels for classifying that
individual card. A card carrying `Refinement` is refined even when it also carries `Feature`, `Improvement`, or `Bug`.

Start dates are compared as absolute instants using `Date.parse`, including timezone offsets. This start-date rule applies
only while claiming cards from `Ready for Agent`; it does not reorder cards or affect cards already in another workflow list.

## Refinement

When a refinement card is claimed:

1. The orchestrator prepares `<worktreeRoot>/<trello-card-id>` on `agent/<trello-card-id>` before moving the card to
   `Working`.
2. The orchestrator reconciles the current Trello attachments into the card context immediately before the refinement
   session. OpenCode may inspect repository code, tests, documentation, and architecture. It must not modify repository
   implementation files; its only permitted write is the dedicated structured refinement result artifact.
   The artifact must be a strict JSON object containing only non-blank `title` and `description` strings and a `type` set to
   exactly `feature`, `improvement`, or `bug`.
3. The orchestrator validates the structured result and rejects unauthorized repository changes.
4. It updates the Trello title and description, removes conflicting implementation labels, applies exactly one of
   `Feature`, `Improvement`, or `Bug`, removes `Refinement`, and moves the card to the top of `Backlog`.
5. After the move succeeds, it attempts the optional refinement-completion email and adds one concise Trello comment containing
   the classification, refined title, and, when reliable transition history is available, elapsed workflow time. The comment
   does not repeat the refined task description.
6. The successful refinement result artifact is cleared and the refinement worktree is cleaned up on a best-effort basis. A
   failure identifies the project, card, operation, and artifact in a warning and preserves the artifact when it cannot be
   removed; it does not change the confirmed `Backlog` result.

Email and comment failures are logged independently and do not undo the successful `Backlog` transition. If refinement
fails, produces an invalid result, or modifies unauthorized repository files, the card is sent through normal failure
handling to `Failed`. Its deliberate retry action is to move it to `Ready for Agent`; see [Recovery](recovery.md).

## Implementation and quality gates

An implementation card is claimed only from `Ready for Agent`. The project mutation queue serializes implementation, refinement,
CI repair, and feedback remediation; an owned worktree and a persisted primary session are tied to the task record. The coordinator
runs optional `setupCommand`, reconciles current Trello attachment context, and attempts structured planning and independent
plan review as bounded advice before implementation.

The primary session implements the task using the available plan and advisory feedback. The orchestrator—not the agent—runs any
configured `validationCommand` and `coverageCommand`, binding each result to the exact
source content. These commands are independently optional: an absent command is recorded
as skipped, never passed. An independent reviewer uses a separate session to assess the
plan's requirements. Validation, coverage, and review repairs are bounded; after the last
correction the relevant configured checks run again.

Current passing checks and no known material unresolved issues permit normal
publication; failed, skipped or uncertain checks and material outstanding findings
are disclosed on a draft PR. Bounded advisory validation and review can improve the
result but cannot veto safe publication of meaningful work. Exhausted quality advice
is not a primary-process crash. Missing safety evidence, stale source snapshots or
ambiguous external acceptance still require reconciliation, not an assumed success.
Neither review nor CI evidence authorizes automatic merging.

The orchestrator then creates one trusted commit with the configured Git identity and publishes or reuses the same task PR through
fetch and ordinary fast-forward-safe push. This release disables automatic rebasing and prepared-conflict continuation,
including unpublished publication rebases. If publication would require rewriting history, the worktree and PR state are preserved
for safe recovery. The optional post-commit PR-description session is presentation-only: if structured
output or rendering fails, a deterministic Trello-link/attribution body is used without weakening publication gates. Failures
preserve the owned worktree and durable task state for recovery; they do not create a success transition.

The description result contract is strict: `summary` is a non-blank string of at most 1,000 characters, while `changes` and
`validation` are arrays of at most 20 non-blank strings each, with every entry limited to 500 characters. Empty arrays are
allowed, including an empty `validation` array when no validation or test result is known. JSON wrapped in Markdown, missing
fields, wrong types, extra fields, and values beyond these fixed bounds are rejected. The result is generated after publication
rebasing. The standalone application renderer for this contract uses the fixed `Summary`, `Changes`, `Validation`,
and `Task` sections, places the application-provided Trello card link in `Task`, adds the same attribution footer using
`projects[].repository.gitIdentity.name`, and reserves exactly one `<!-- agent-orchestrator-status:start -->` /
`<!-- agent-orchestrator-status:end -->` region. Empty
`changes` render as `No changes were provided.` and empty `validation` renders as `No validation or test results were provided.`;
neither claims success. Generated values are rendered as single-line content so they cannot add headings, footer text, or status
markers. The rendered result is passed to pull-request creation. An existing open pull request is reused without rewriting its
description.

Implementation and later primary corrections retain the task's primary OpenCode session.
Independent planning and implementation reviews use separate sessions. Sessions are
traceable in retained task logs; operation budgets and recovery identities are durable
runtime state, not counters inferred from or written into Trello card content.

## Publication

New initial publications use a durable publication journal:
intent precedes commit/push/PR dispatch, independently verified actual PR identity
is persisted before Trello effects, and the Human Review destination is read back.
Polling resumes the same checkpoint after service recovery without recreating the
PR or initial commit. A negative lookup does not authorize resending an ambiguous
creation. Existing uncertain legacy publications without dispatch provenance stay
preserved and blocked rather than being treated as fresh creation attempts.
Existing-PR mutations and refinement/terminal operations use the same durable
mutation mechanisms. Under production attempt
authority, pending workflow comments, field updates, Git effects and cleanup
dispatches retain ownership until independently reconciled; negative reads do not
authorize resending. The legacy best-effort descriptions elsewhere on this page
do not override that journal/release gate. Email delivery remains separate,
nonblocking work and cannot undo successful publication.

Before publication, the task worktree fetches `origin/<defaultBranch>` but does not rebase. A missing task branch or fast-forward
update is published with an ordinary push. A branch requiring a rewrite or conflict continuation is refused and preserved. The
configured source checkout is not used for these operations.

An existing open pull request is reused; a new one is created only when none exists. After publication, every exact-head CI check
run and commit status is collected and evaluated against the complete expectation set. The card remains in `Human Review` while
checks are pending or the expected set is uncertain. A complete failure set starts at most two CI repair rounds in the existing
primary session; each correction reruns local validation/coverage and independent review, publishes to the same PR, and invalidates
all prior-head CI evidence. A successful complete CI result leaves the open PR in Human Review; approval and passing checks do not
merge or complete it. Only an independently observed human merge permits the card to move to `Done` with `dueComplete: true`; a
human unmerged closure routes it to `Backlog`. A publication or card-transition failure does not produce a successful completion.

## Human review

Human review takes place on GitHub. The orchestrator never merges a pull request. Approval is an observation, not a terminal event;
every open normal or draft PR remains active and blocks the project's next task.

Human merge or closure takes precedence over active or queued corrections, CI repair
and maintenance. PR observation continues during execution, capacity waits and future
dependency rechecks. A verified terminal observation durably fences new automated
mutations and cancels the active writer's process tree where possible. Publication
checks the original PR before pushing and before returning the card to Human Review;
a rejected push triggers authoritative outcome reconciliation, not branch recreation.
Even a newly created PR closed before its local publication binding is reconciled as
the original PR rather than replaced.

Already-dispatched effects must be reconciled before terminal release: an uncertain
Review move or reply is never blindly resent or assumed cancelled. Unknown execution
retains project ownership; missing PID/process group is not stopped proof. Once writers
are verified stopped, superseded queued work is retired, the temporary owned activity
block is removed without replacing human content, and terminal Trello state is verified.
Unshipped commits, dirty worktrees and ambiguous artifact ownership are preserved rather
than cleaned up. Interrupted primary work is recorded as cancelled, not as a fabricated
implementation crash or a successfully published correction.

| GitHub state                                                 | Trello result                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| Pull request merged                                          | Move the card to `Done` and mark it complete                       |
| Pull request closed without merge                            | Move the card to `Backlog` and add the closed-PR comment           |
| Open pull request with changes requested on its current head | Move the card to `Working` and pass the feedback to OpenCode       |
| Open pull request without actionable requested changes       | Leave the card in `Human Review` and observe complete CI evidence  |
| Expected pull request unavailable or identity uncertain      | Preserve ownership and reconcile; do not assume a terminal outcome |

After an owned pull request reaches either terminal state, reconciliation attempts to remove only the dedicated
`<worktreeRoot>/<trello-card-id>` worktree and its local `agent/<trello-card-id>` branch. For a merged pull request this
attempt happens after remote branch cleanup, the successful `Done` transition, and completion notification handling. For a
closed pull request it happens after the successful `Backlog` transition and explanatory comment attempt. This cleanup is
best effort: a warning includes the project, card, paths, and failure, but it never undoes a terminal transition or blocks
the next reconciliation.

The local cleanup is skipped when the path is outside the configured root, is symbolic or unexpected, is associated with a
different branch, has unmerged paths or an active rebase, is dirty, or has a prepared-conflict handoff requiring recovery.
Already-absent worktrees and branches are successful idempotent outcomes. Shutdown cancellation stops before destructive
cleanup, and preserved worktrees, branches, and prepared-conflict handoffs remain available for diagnosis.

When requested changes are detected, the orchestrator uses the owned worktree and existing task branch, supplies the GitHub
review feedback to the implementation session after refreshing the current Trello attachment context, runs the same initial-review and
bounded remediation loop, and republishes the updated branch and pull request. The open PR remains in Human Review after publication.
The existing owned worktree/branch and primary session are reused. The card moves to Working before correction and returns to
Human Review after publication or a no-op, with both list outcomes verified. Pending transitions and the verified expected list
are persisted independently of internal execution phase, including across acknowledgment loss or restart. Older published
correction records retain their previous Human Review expectation until a verified explicit transition occurs.
Validation, coverage and independent review are advisory during correction: failed checks or bounded review unavailability
cannot veto additive publication to the same PR. Current failures, skipped/uncertain results and unresolved requests keep the PR
as a draft and are disclosed. Review dispatch recovery is bounded per source and retained across interruption; human-requested
rounds have no lifetime cap. A genuinely unrecoverable primary correction preserves the PR, unshipped changes and ownership in
an explicit recoverable wait, rather than failing the task or publishing interrupted work as a correction.
A requested-changes pass captures the authoritative PR head
SHA used to select the feedback and re-reads the expected open PR head after review bodies and inline comments have been collected.
Only a stable, commit-exact snapshot can move the card to Working or reach OpenCode. If the head changes, the complete snapshot is
discarded, the card remains in Human Review with its existing PR and branch, and reconciliation logs the project, card, PR, and both
SHAs before retrying on the next poll. A retry that reuses already committed work skips all OpenCode stages, including
attachment-dependent prompts, and proceeds directly to publication.

Human feedback includes review summaries, standalone PR comments and inline discussions, including discussion submitted without
a changes-requested verdict. It does not require a new review on the current head. A later decisive review by the same author
supersedes that author's earlier review summary; independent inline discussions remain eligible until resolved or outdated.
Each item preserves its source identity, reviewer, available timestamp and inline context. GitHub Bot actors, the authenticated
automation actor and managed automation replies/status markers do not trigger corrections.
Review bodies are treated as general pull-request-level feedback and have no file, line, or diff location. Inline comments retain
each location field GitHub supplies, including a path, current line, original line, or diff hunk. Resolved, outdated, and
incompletely described threads are excluded or fail reconciliation rather than being inferred. This applies to review-body-only,
inline-only, and mixed feedback.

OpenCode classifies semantic actionability and whether an edited requested action substantively changed, using a read-only
operation. The orchestrator validates complete source-revision/identity coverage before updating the ledger. Latest bodies are
separate from append-only prior handling snapshots; deleted or superseded items are no longer active. Timestamp changes, new
commits and incidental edits do not renew an attempted request. A substantive changed request can start another cycle.

If a feedback remediation produces no repository changes, it is not treated as resolved: the ledger retains the unresolved
attempted item and the workflow does not publish a correction or claim success. Unchanged feedback does not restart that attempt,
even after a new PR head. The task remains available for new or substantively changed human input, or human merge/closure.
An initial implementation still requires repository changes; validation/review repair remains scoped to its approved task.

For each owned open PR, the coordinator verifies repository, branch, URL, persisted head, and current GitHub head before acting.
Observation continues during an active writer, retaining deduplicated arrivals outside the repository. Unclassified feedback
cannot dispatch a writer. Current human requests take priority over queued CI repair, followed by routine maintenance; an
already-running operation is not preempted by new feedback. Explicit required prerequisites may run first. Pending descriptors
and their order survive restart, and only never-started work superseded by authoritative current observations is retired.
It normalizes submitted review bodies, unresolved inline threads, and conversation comments into a durable task-scoped ledger.
Actionable feedback is remediated in the original primary session, then independently verified; earlier still-applicable items remain
tracked when new feedback arrives. Replies refer to the observed published head, using the originating thread when available
or an attributed PR comment linking a review summary or inline source. Replies distinguish independently
verified fixes, established unresolved requests and uncertain fulfillment. Pending or failed CI does not prevent a truthful reply;
its observed current-head status is reported rather than called a pass. A published reply does not mean a request was fulfilled.
Unknown reply acceptance is reconciled by the original marker, including after an edit/deletion; a negative lookup never
authorizes a blind resend. The service never approves a PR, dismisses a review, or resolves a reviewer thread.

During correction, a managed activity block appears at the top of the PR description and changes as work proceeds through
editing, validation and publication. It is cleared on verified completion; unknown execution is reported as requiring attention
rather than silently declared stopped. Managed body edits preserve human content outside owned markers. A detected intervening
human edit cancels only an intent that never dispatched, then refreshes the intended body. Already-dispatched uncertainty is
reconciled first. These read/compare checks are not atomic provider-side compare-and-write and cannot prevent every late race.
A no-op correction retains an unresolved outcome, refreshes the managed description without claiming a new commit/check, and
can resume interrupted reporting without rerunning the primary correction.

Pending or uncertain CI retains the PR in `Human Review` without consuming a repair attempt. Complete failures start one bounded
CI repair operation containing all failed checks; a published new head invalidates every previous check observation. Automatic
merging is prohibited. An unknown expected-check set, missing check, stale head,
or incomplete GitHub response never counts as green.

Open PRs, including approved PRs, automatically receive queued additive target
merges when needed. Published commits are never rewritten. Conflict assistance
uses the original primary session and current attachments; its operation identity
and maximum survive restart. Validation and independent review are advisory, and
safe available changes publish to the same draft PR with current diagnostics and
pending CI disclosed. Dirty excluded output and unshipped commits are preserved;
unrelated staged output or unknown local-only commits are not automatically shipped.

Rebase and legacy prepared-conflict continuation remain disabled.
Existing legacy handoffs and maintenance records remain diagnostic artifacts; their presence or apparent local completion does not
authorize continuation. The task branch, PR, local commits, remote refs/objects, dirty or unshipped work, intent, and handoff are
preserved. The worker may continue read-only PR observation and verified terminal reconciliation, but it does not run branch
writers or start a new task for an affected card. Operator guidance is in [Recovery](recovery.md).
There is no automatic replay of legacy intents, rebase, force-push, reset, abort, or silent success.

Trello and GitHub operations used by discovery, reconciliation, transition-history checks, card moves, content and label
updates, comments, and attachment context are retryable when the service returns HTTP 500, 502, 503, or 504, a rate limit, a
timeout, or a temporary network/connectivity error. A failed authoritative Trello read does not mean that a card is missing,
misplaced, or invalid. A failed Trello mutation is not confirmed. The card remains in its last known list, and no corrective
comment, failure transition, or workflow decision is made from incomplete Trello state. The project worker logs each attempt
and retries on a later polling cycle, up to three consecutive attempts. Exhaustion blocks the affected card operation and uses
the existing project diagnostic and `Attention Required` escalation without calling that operation on subsequent normal polls.
After the external failure is resolved, moving the affected card from its recorded reconciliation list to `Ready for Agent` is
the explicit recovery condition; the worker then clears the counter and resumes. Project-level failures without a card identity
require an explicit worker restart after resolution. Invalid authentication, configuration, malformed responses, not-found
errors, and other non-transient errors retain immediate failure handling. Shutdown cancellation is not retryable. Cards already
in `Failed` are never automatically retried.

## Failures and transitions

Automated failures move the card to `Failed` rather than silently advancing it. A failure comment contains the category,
reason, and the instruction to move the card to `Ready for Agent` for a deliberate retry. If moving the card to `Failed`
fails, the orchestrator preserves the primary failure and does not pretend that failure handling completed. If adding the
failure comment fails after the move, the card remains in `Failed` and the comment failure is logged.

A pull request that a human closes without merging is a deliberate rejection or cancellation, not an automated failure. The
card is moved to `Backlog` and receives a comment stating that the pull request was closed without being merged, with its URL;
this outcome does not send the `failed` notification. If the `Backlog` move fails, the reconciliation fails with diagnostic
context and no cancellation comment is added. If the move succeeds but the comment fails, the card remains in `Backlog` and
the comment failure is logged.

An external operation must succeed before its related workflow transition is treated as complete. If a merge succeeds but moving
the card to `Done` fails, persisted terminal PR reconciliation retries the Trello transition without attempting another merge. A
closed PR transition is similarly idempotent and returns to `Backlog`. See [Recovery](recovery.md) for these states.
