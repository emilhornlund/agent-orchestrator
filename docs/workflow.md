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
3. The orchestrator validates the structured result and rejects unauthorized repository changes.
4. It updates the Trello title and description, removes conflicting implementation labels, applies exactly one of
   `Feature`, `Improvement`, or `Bug`, removes `Refinement`, and moves the card to the top of `Backlog`.
5. After the move succeeds, it attempts the optional refinement-completion email and adds one concise Trello comment containing
   the classification, refined title, and, when reliable transition history is available, elapsed workflow time. The comment
   does not repeat the refined task description.
6. The successful refinement result artifact is cleared and the refinement worktree is cleaned up.

Email and comment failures are logged independently and do not undo the successful `Backlog` transition. If refinement
fails, produces an invalid result, or modifies unauthorized repository files, the card is sent through normal failure
handling to `Failed`. Its deliberate retry action is to move it to `Ready for Agent`; see [Recovery](recovery.md).

## Implementation

An implementation card is claimed only from `Ready for Agent`. The worktree is prepared before the card is moved to
`Working`, so a failed card claim does not leave the next attempt without its expected worktree.

The implementation pass then:

1. Runs the optional `repository.setupCommand` in the card worktree.
2. Reconciles the current Trello attachments immediately before each applicable OpenCode session. Uploaded files are
   materialized outside the repository and worktree; external URLs remain metadata-only.
3. Runs an OpenCode implementation session using the configured implementation model and variant.
4. Requires OpenCode to leave repository changes. The configured `validationCommand`, when present, is supplied to sessions
   that modify implementation files; those agents run it before finishing and fix failures caused by their changes. The
   orchestrator does not execute this command itself.
5. Refreshes the current Trello attachment context immediately before every automatic review, then runs the initial
   separate OpenCode review session with compact attachment metadata and usable locations. This review is always run and
   does not consume a remediation pass.
6. If a review reports findings and `projects[].opencode.remediation.maxPasses` has remaining capacity, refreshes the card
   context immediately before each separate remediation session and checks that it left repository changes. The pass number
   and configured limit are logged with the project and card context. A new review runs only when another remediation pass
   remains. The default limit is `1`; a value of `0` skips remediation and any follow-up review while continuing through the
   normal post-review flow.
7. Stops immediately when the initial or an intermediate review passes. After the final allowed remediation pass, the workflow
   continues directly to the normal post-review flow without another automated review. Review attachment context is refreshed
   separately for each review and is not reused from implementation or remediation.
8. Runs a separate OpenCode commit session with the configured Git identity. The session must create a commit and leave a
   clean worktree.
9. Publishes or reuses the task pull request. With `autoMerge: false`, the card moves to `Human Review`; with `autoMerge: true`,
   the pull request is merged and the card moves directly to `Done`.

An OpenCode stage that exits unsuccessfully, produces no expected changes, fails to create a commit, or leaves changes after
the commit stage fails the workflow. Publication details and non-force-push boundaries are in [Operations](operations.md).

Implementation, each review, each remediation pass, and commit use separate OpenCode sessions. Each session can be found in
the card's session log while it is retained. The pass counter is transient to this automated workflow execution; it is not
inferred from or persisted to Trello card data.

## Publication

Before publication, the task worktree fetches `origin/<defaultBranch>` and rebases `agent/<trello-card-id>` onto that
reference. The resulting `HEAD` is used for remote-branch comparison, push decisions, pull-request publication,
notifications, and the Trello summary. The configured source checkout is not used for these operations.

An existing open pull request is reused; a new one is created only when none exists. With `autoMerge: false`, successful
publication moves the card to `Human Review`, adds a Trello summary with the pull-request URL, commit, review result,
remediation result, and, when available, elapsed workflow time, and uses the Human Review email path. With `autoMerge: true`,
the expected pull request is merged immediately after publication. Only a successful merge permits the card to move to `Done`
with `dueComplete: true`; after that transition the orchestrator attempts the existing `done` email and adds a distinct
auto-merged summary containing the pull-request URL, final published commit, and automated review/remediation results. A
publication, merge, or card-transition failure does not produce a successful completion.

## Human review

Human review takes place on GitHub when `autoMerge` is disabled. The orchestrator never merges a pull request for a project
with `autoMerge: false`; an enabled project merges only its normal implementation pull requests after successful publication.

| GitHub state                                                 | Trello result                                                  |
| ------------------------------------------------------------ | -------------------------------------------------------------- |
| Pull request merged                                          | Move the card to `Done` and mark it complete                   |
| Pull request closed without merge                            | Move the card to `Backlog` and add the closed-PR comment       |
| Open pull request with changes requested on its current head | Move the card to `Working` and pass the feedback to OpenCode   |
| Open pull request without actionable requested changes       | Leave the card in `Human Review`; expose its maintenance state |
| No expected pull request                                     | Reconcile the card to `Backlog`                                |

When requested changes are detected, the orchestrator creates a worktree from the existing task branch, supplies the GitHub
feedback to the implementation session after refreshing the current Trello attachment context, runs the same initial-review and
bounded remediation loop, and republishes the updated branch and pull request. An enabled project auto-merges the successfully
republished pull request; a disabled project returns it to Human Review. A requested-changes pass starts only when the review
feedback applies to the pull request's current head, and it gets its own transient remediation counter. A retry that reuses
already committed work skips all OpenCode stages, including attachment-dependent prompts, and proceeds directly to publication.

For every owned open pull request on the expected `agent/<trello-card-id>` branch, Human Review reconciliation records one
detection-only maintenance state: `up-to-date` when the configured default branch is not ahead and GitHub reports no conflict,
`behind` when the default branch has advanced without a conflict, or `conflicted` when GitHub reports merge conflicts. Pull
requests on other branches, and closed or merged pull requests, are outside this signal. The result is part of the
reconciliation data rather than a log-only message. Detection never rebases, merges, pushes, force-pushes, changes a branch or
worktree, moves a card, or invokes OpenCode.

Trello and GitHub operations used by discovery, reconciliation, transition-history checks, card moves, content and label
updates, comments, and attachment context are retryable when the service returns HTTP 500, 502, 503, or 504, a rate limit, a
timeout, or a temporary network/connectivity error. A failed authoritative Trello read does not mean that a card is missing,
misplaced, or invalid. A failed Trello mutation is not confirmed. The card remains in its last known list, and no corrective
comment, failure transition, or workflow decision is made from incomplete Trello state. The project worker logs each attempt
and retries on a later polling cycle, up to three consecutive attempts. Recovery clears the counter; exhaustion uses the
existing project diagnostic and `Attention Required` escalation. Invalid authentication, configuration failures, malformed
responses, not-found errors, and other non-transient errors retain immediate failure handling. Shutdown cancellation is not
retryable. Cards already in `Failed` are never automatically retried.

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

An external operation must succeed before its related workflow transition is treated as complete. For example, if an enabled
project merged a pull request but moving the card to `Done` failed, the card remains available for reconciliation as a merged
`Working` card; reconciliation completes it without attempting another merge. If a disabled project published but moving the
card to `Human Review` failed, the same published `Working` recovery applies. See [Recovery](recovery.md) for these states.
