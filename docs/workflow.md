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

When `projects[].autoMerge` is `true`, the implementation branch instead follows this path after publication:

```text
Ready for Agent -> Working -> publish expected PR -> merge PR -> Done
```

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
Ready for Agent -> Working -> approved plan + independent plan check
  -> implementation in the persisted primary OpenCode session
  -> orchestrator validation + configured coverage + independent review
  -> trusted commit + existing/new PR publication
  -> discover expected checks + observe all exact-head check runs and commit statuses
       -> waiting/uncertain: preserve state; do not repair, reply, or merge
       -> complete failures: bounded same-session repair -> local gates/review -> same PR -> re-observe new head
       -> complete pass: Human Review, or auto-merge when explicitly enabled
  -> Human Review: ledger actionable feedback -> same primary session -> verify -> gates -> publish -> CI -> contextual reply
  -> manually merged PR -> Done; deliberately closed PR -> Backlog
```

One primary OpenCode session ID is persisted per task and resumed for implementation, CI repair, and human-feedback remediation.
Independent plan and implementation reviewers use separate sessions. The orchestrator, not OpenCode, decides whether local
commands, independent review, and CI evidence pass before publication, feedback replies, or auto-merge. The
exception is a structurally valid, content-bound failed implementation review after the configured
`remediation.maxPasses`: local validation/coverage must pass and the PR is published for human
review with an explicit warning, but is never automatically merged. Other exhausted or ambiguous
operations preserve their durable records and require operator attention. No manual check-name configuration is required. Local
mock tests cover the lifecycle; no live Trello/GitHub/OpenCode pilot has been performed. See
[Configuration](configuration.md#ci-expectation-discovery) and [Recovery](recovery.md#task-session-recovery).

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
runs optional `setupCommand`, reconciles current Trello attachment context, creates a structured plan, and requires independent
plan verification before code changes begin.

The primary session implements the approved plan. The orchestrator—not the agent—runs the required `validationCommand` and any
configured `coverageCommand`, binding each result to the exact source content. An independent reviewer uses a separate session to
assess every approved requirement. Validation, coverage, and review repairs are bounded; after the last correction the relevant
checks run again. A passing final review permits normal publication and, separately, possible
auto-merge. If the independent implementation review remains failed after the configured
remediation limit, successful current validation and coverage still permit publication to Human
Review only. The failed findings are preserved and disclosed on the PR; this outcome is not a
workflow error and sends no Attention Required notification. Failed local validation, missing
evidence, stale snapshots, and ambiguous publication remain blocked.

The orchestrator then creates one trusted commit with the configured Git identity and publishes or reuses the same task PR through
the safe fetch/rebase and non-force-push path. The optional post-commit PR-description session is presentation-only: if structured
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

Implementation, each review, each remediation pass, commit, and description generation use separate OpenCode sessions. Each session can be found in
the card's session log while it is retained. The pass counter is transient to this automated workflow execution; it is not
inferred from or persisted to Trello card data.

## Publication

Before publication, the task worktree fetches `origin/<defaultBranch>` and rebases `agent/<trello-card-id>` onto that
reference. The resulting `HEAD` is used for remote-branch comparison, push decisions, pull-request publication,
notifications, and the Trello summary. The configured source checkout is not used for these operations.

An existing open pull request is reused; a new one is created only when none exists. After publication, every exact-head CI check
run and commit status is collected and evaluated against the complete expectation set. The card remains in `Human Review` while
checks are pending or the expected set is uncertain. A complete failure set starts at most two CI repair rounds in the existing
primary session; each correction reruns local validation/coverage and independent review, publishes to the same PR, and invalidates
all prior-head CI evidence. With `autoMerge: false`, a successful complete CI result permits Human Review. With `autoMerge: true`,
merge is deferred until local quality gates, review, and complete current-head CI all pass. Only a successful merge permits the
card to move to `Done` with `dueComplete: true`; completion notification and summary follow that transition. A publication, merge,
or card-transition failure does not produce a successful completion.

## Human review

Human review takes place on GitHub when `autoMerge` is disabled. The orchestrator never merges a pull request for a project
with `autoMerge: false`; an enabled project merges only task-session implementation PRs after complete CI and local gates pass.

| GitHub state                                                 | Trello result                                                     |
| ------------------------------------------------------------ | ----------------------------------------------------------------- |
| Pull request merged                                          | Move the card to `Done` and mark it complete                      |
| Pull request closed without merge                            | Move the card to `Backlog` and add the closed-PR comment          |
| Open pull request with changes requested on its current head | Move the card to `Working` and pass the feedback to OpenCode      |
| Open pull request without actionable requested changes       | Leave the card in `Human Review` and observe complete CI evidence |
| No expected pull request                                     | Reconcile the card to `Backlog`                                   |

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

When requested changes are detected, the orchestrator creates a worktree from the existing task branch, supplies the GitHub
review feedback to the implementation session after refreshing the current Trello attachment context, runs the same initial-review and
bounded remediation loop, and republishes the updated branch and pull request. An enabled project auto-merges the successfully
republished pull request; a disabled project returns it to Human Review. A requested-changes pass captures the authoritative PR head
SHA used to select the feedback and re-reads the expected open PR head after review bodies and inline comments have been collected.
Only a stable, commit-exact snapshot can move the card to Working or reach OpenCode. If the head changes, the complete snapshot is
discarded, the card remains in Human Review with its existing PR and branch, and reconciliation logs the project, card, PR, and both
SHAs before retrying on the next poll. A retry that reuses already committed work skips all OpenCode stages, including
attachment-dependent prompts, and proceeds directly to publication.

Requested-changes remediation feedback includes a separate, attributed section for every submitted `CHANGES_REQUESTED` review
targeting the pull request's current head. Once that current-head review state makes a remediation round eligible, unresolved
inline threads from earlier heads are also included when GitHub explicitly reports them as unresolved and not outdated. Earlier
thread sections are marked as carried-forward unresolved inline feedback and contain no earlier review body. Each section
preserves the review or thread identity, reviewer, submission timestamp, and only the inline comments belonging to that review.
Review bodies are treated as general pull-request-level feedback and have no file, line, or diff location. Inline comments retain
each location field GitHub supplies, including a path, current line, original line, or diff hunk. Resolved, outdated, and
incompletely described threads are excluded or fail reconciliation rather than being inferred. This applies to review-body-only,
inline-only, and mixed feedback.

If a feedback remediation produces no repository changes, it is not treated as resolved: the ledger retains the item and the
workflow does not publish a correction or claim success. The task remains available for another feedback round or human attention.
An initial implementation still requires repository changes; validation/review repair remains scoped to its approved task.

For each owned open PR, the coordinator verifies repository, branch, URL, persisted head, and current GitHub head before acting.
It normalizes submitted review bodies, unresolved inline threads, and conversation comments into a durable task-scoped ledger.
Actionable feedback is remediated in the original primary session, then independently verified; earlier still-applicable items remain
tracked when new feedback arrives. Replies are sent only in the originating conversation/thread after the correcting commit has
been published and the complete current-head CI result passes. The service never approves a PR, dismisses a review, or resolves a
reviewer thread.

Pending or uncertain CI retains the PR in `Human Review` without consuming a repair attempt. Complete failures start one bounded
CI repair operation containing all failed checks; a published new head invalidates every previous check observation. Auto-merge
is allowed only after complete expected checks and local evidence pass. An unknown expected-check set, missing check, stale head,
or incomplete GitHub response never counts as green.

A lease rejection, missing or invalid remote SHA, fetch or non-conflict rebase failure leaves the pull
request, card, task branch, and worktree unchanged for diagnosis and later reconciliation. When Git confirms an active conflicted
rebase and reports conflicted paths, orchestration writes a validated handoff at
`<worktreeRoot>/.orchestrator/prepared-conflicts/<project-id>/<card-id>.json`. The shared handoff records its lifecycle origin,
the project and card IDs, `agent/<card-id>`, the configured default branch, the trusted pre-rebase task commit, the captured
rebase target, conflicted paths, and current rebase metadata. Initial publication is authorized by the trusted local commit and
captured target; no replacement PR is created.

For an initial-publication conflict, the card remains owned by the implementation workflow while the preserved worktree is routed
through dedicated OpenCode conflict remediation. The orchestrator does not move the card to `Failed` merely because normal merge
conflicts occurred, and it never aborts, resets, cleans, removes, recreates, or automatically resolves the conflicted worktree or
rebase outside that remediation session.

Prepared retries keep strict worktree, task-branch, repository, and rebase identity checks. Rebase progress is not identity:
the captured conflict step or legitimate forward progress to a later stop is accepted when the progress is positive and within
the available range. Present `totalSteps` values must agree; unavailable optional progress metadata does not by itself reject
the same prepared rebase.

A valid prepared-conflict handoff is an active remediation state. Reconciliation is idempotent while it exists and does not start
another rebase. The project worker does not process another Working or Ready card, publication, or cleanup
until dedicated remediation has inspected the worktree. Remediation revalidates the handoff and isolated worktree, starts one
OpenCode session using the configured `opencode.remediation` model and variant, and supplies the card title and description, task
branch, updated base and rebase target, conflicted paths, active-rebase status, and configured validation command. OpenCode is
instructed to resolve only the active conflicts, preserve compatible task and upstream changes, stage each resolution, and continue
every conflict stop until the rebase completes. A malformed or incomplete handoff, or a rebase error without an active conflict and
conflicted paths, uses normal failure diagnostics and never reports `prepared-conflict`.

After the session, orchestration requires no active rebase, no unmerged paths, a valid worktree on `agent/<card-id>`, and a clean
publication state. The OpenCode conflict-remediation session owns running the configured `validationCommand` and fixing failures;
the orchestrator independently re-runs the quality and review gates before publication. A verified rebased `HEAD` becomes the new
trusted commit and resumes the normal safe push and existing-PR publication flow. A successful completion clears the handoff last.
No replacement pull request, merge, unrelated Trello transition, or worktree cleanup is performed by the conflict resolver.

An unsuccessful, timed-out, permission-denied, incomplete, or lease-rejected remediation preserves the handoff and worktree and
uses the normal failure diagnostic and `Attention Required` path. The worker permits only the existing bounded remediation retry
count; after exhaustion it blocks the project and periodically checks the handoff and underlying Git conflict state without
starting remediation again. Other cards in that project cannot start while this state remains active. Once the handoff is removed
or a completed underlying rebase is verified, the worker clears the block and resumes normal processing without a restart.

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
