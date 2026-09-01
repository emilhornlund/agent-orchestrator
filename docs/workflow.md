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
       +-> closed without merge ----> Failed
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

All four labels must exist on the configured board. A card in `Ready for Agent` is eligible for normal implementation only
when it has at least one of the configured `Feature`, `Improvement`, or `Bug` labels. Unlabelled cards are ignored.

`Refinement` takes precedence over implementation labels. A card carrying `Refinement` is refined even when it also carries
`Feature`, `Improvement`, or `Bug`.

## Refinement

When a refinement card is claimed:

1. The orchestrator prepares `<worktreeRoot>/<trello-card-id>` on `agent/<trello-card-id>` before moving the card to
   `Working`.
2. OpenCode may inspect repository code, tests, documentation, and architecture. It must not modify repository
   implementation files; its only permitted write is the dedicated structured refinement result artifact.
3. The orchestrator validates the structured result and rejects unauthorized repository changes.
4. It updates the Trello title and description, removes conflicting implementation labels, applies exactly one of
   `Feature`, `Improvement`, or `Bug`, removes `Refinement`, and moves the card to the top of `Backlog`.
5. After the move succeeds, it attempts the optional refinement-completion email and adds one Trello comment containing the
   classification, refined title, and refined task description.
6. The successful refinement result artifact is cleared and the refinement worktree is cleaned up.

Email and comment failures are logged independently and do not undo the successful `Backlog` transition. If refinement
fails, produces an invalid result, or modifies unauthorized repository files, the card is sent through normal failure
handling to `Failed`. Its deliberate retry action is to move it to `Ready for Agent`; see [Recovery](recovery.md).

## Implementation

An implementation card is claimed only from `Ready for Agent`. The worktree is prepared before the card is moved to
`Working`, so a failed card claim does not leave the next attempt without its expected worktree.

The implementation pass then:

1. Runs the optional `repository.setupCommand` in the card worktree.
2. Runs an OpenCode implementation session using the configured implementation model and variant.
3. Requires OpenCode to leave repository changes. The configured `validationCommand`, when present, is supplied to sessions
   that modify implementation files; those agents run it before finishing and fix failures caused by their changes. The
   orchestrator does not execute this command itself.
4. Runs a separate OpenCode review session.
5. If the review reports findings, runs a separate remediation session and checks that remediation left repository changes.
6. Runs a separate OpenCode commit session with the configured Git identity. The session must create a commit and leave a
   clean worktree.
7. Publishes the task branch and pull request, then moves the card to `Human Review`.

An OpenCode stage that exits unsuccessfully, produces no expected changes, fails to create a commit, or leaves changes after
the commit stage fails the workflow. Publication details and non-force-push boundaries are in [Operations](operations.md).

Implementation, review, remediation, and commit use separate OpenCode sessions. Each session can be found in the card's
session log while it is retained.

## Publication

Before publication, the task worktree fetches `origin/<defaultBranch>` and rebases `agent/<trello-card-id>` onto that
reference. The resulting `HEAD` is used for remote-branch comparison, push decisions, pull-request publication,
notifications, and the Trello summary. The configured source checkout is not used for these operations.

An existing open pull request is reused; a new one is created only when none exists. A successful publication moves the card
to `Human Review` and adds a Trello summary with the pull-request URL, commit, review result, remediation result, and, when
available, elapsed workflow time. A publication failure does not produce a successful card transition.

## Human review

Human review takes place on GitHub. The orchestrator never merges a pull request.

| GitHub state                                                 | Trello result                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| Pull request merged                                          | Move the card to `Done` and mark it complete                 |
| Pull request closed without merge                            | Move the card to `Failed` and add the failure comment        |
| Open pull request with changes requested on its current head | Move the card to `Working` and pass the feedback to OpenCode |
| Open pull request without actionable requested changes       | Leave the card in `Human Review`                             |
| No expected pull request                                     | Reconcile the card to `Backlog`                              |

When requested changes are detected, the orchestrator creates a worktree from the existing task branch, supplies the GitHub
feedback to the implementation session, runs review and remediation again as needed, and republishes the updated branch and
pull request. A requested-changes pass starts only when the review feedback applies to the pull request's current head.

## Failures and transitions

Automated failures move the card to `Failed` rather than silently advancing it. A failure comment contains the category,
reason, and the instruction to move the card to `Ready for Agent` for a deliberate retry. If moving the card to `Failed`
fails, the orchestrator preserves the primary failure and does not pretend that failure handling completed. If adding the
failure comment fails after the move, the card remains in `Failed` and the comment failure is logged.

An external operation must succeed before its related workflow transition is treated as complete. For example, if a pull
request was published but moving the card to `Human Review` failed, the card remains available for reconciliation as a
published `Working` card; it is not silently marked successful or failed. See [Recovery](recovery.md) for these states.
