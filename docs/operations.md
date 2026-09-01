# Operations

[README](../README.md) | [Workflow](workflow.md) | [Configuration](configuration.md) | [Recovery](recovery.md)

This page is the canonical operator reference for execution isolation, publication boundaries, timing, notifications,
shutdown, logging, retention, and multi-project operation.

## Isolated worktrees

The configured `repository.path` is the normal source checkout. Agent execution takes place in a dedicated worktree at
`<worktreeRoot>/<trello-card-id>` on the task branch `agent/<trello-card-id>`. The source checkout is never used as an
agent working directory or as the publication worktree.

Worktree paths must remain under the configured `worktreeRoot`. The service refuses symbolic links, non-directory paths,
unexpected branches, and cleanup requests outside the configured root. Cleanup also refuses to remove a dirty worktree. It
removes only the expected worktree and branch, then prunes known Git worktree metadata; it does not delete arbitrary or
unknown worktrees.

For an initial claim, the expected worktree is prepared before the Trello card is moved to `Working`. A failed move leaves
that prepared worktree available for the next attempt. Reconciliation checks existing worktrees but does not create them.
After a successful implementation publication, cleanup is best effort and a cleanup failure is logged without undoing the
publication or resulting `Human Review` or `Done` transition. Refinement clears its result and attempts cleanup after moving
the card to `Backlog`; a refinement cleanup failure follows normal failure handling while preserving diagnostic state.

## Publication and GitHub boundaries

Immediately before publication, the task worktree fetches `origin/<defaultBranch>` and rebases `agent/<trello-card-id>` onto
that fetched ref. Git leaves an already-current branch unchanged. The resulting `HEAD` drives remote comparison, push
decisions, pull-request publication, notifications, and the Trello summary.

The publication rules are:

- A missing remote task branch is pushed with a normal push.
- A remote branch already at the resulting commit is not pushed again.
- A remote branch that is not an ancestor of the resulting commit is rejected because it would require a non-fast-forward
  update.
- Fetch or rebase failure stops before push, pull-request lookup or creation, and the successful `Human Review` transition.
- An existing open pull request is reused; a new pull request is created only when needed.
- The orchestrator never force-pushes. It merges a pull request only for a project with `autoMerge: true`, after that project's
  normal implementation publication succeeds.

The task worktree and branch are preserved after fetch, rebase, publication, or merge failures so conflicts and diagnostics
can be resolved. A human must review and merge the pull request before the card can reach `Done` when `autoMerge` is disabled.
An enabled project's successful auto-merge is followed by the same `Done` transition and completion handling.

## Elapsed workflow time

When an implementation card is successfully published and moved to `Human Review`, its Trello success comment and Human
Review email can contain a line such as:

```text
Elapsed workflow time: 1 hour 5 minutes
```

This is elapsed workflow time for the current automated pass, not OpenCode-only runtime. The timer starts at:

- `Ready for Agent` to `Working` for an initial pass;
- `Failed` to `Ready for Agent` for a deliberate retry; or
- `Human Review` to `Working` for a review-feedback pass.

It ends at that pass's resulting `Working` to `Human Review` transition. The value uses explicit seconds, minutes, hours,
and days as needed. If Trello action history is missing, incomplete, malformed, ambiguous, or has invalid date ordering, the
summary and Human Review email are still attempted and the card remains in `Human Review`; the elapsed-time line is omitted
and the reason is logged.

## Notifications

Email is optional and disabled when `notifications.email` is omitted or `enabled` is `false`. Configuration, SMTP
credentials, and event defaults are in the [configuration reference](configuration.md#notificationsemail).

When enabled, each event is attempted once after its corresponding successful transition or project-level failure:

| Event                | Sent when                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `humanReview`        | A card successfully enters `Human Review` after normal publication or reconciliation                         |
| `failed`             | A card successfully enters `Failed` through automated failure handling or a closed, unmerged pull request    |
| `refinementComplete` | A refinement card successfully enters `Backlog`                                                              |
| `done`               | A merged pull request successfully moves its card to `Done`, whether it was merged by a human or auto-merged |
| `attentionRequired`  | A project poll or reconciliation cannot safely continue, including ambiguous active-card state               |

The service does not notify for cards merely observed in `Human Review`, `Failed`, or `Done`, unrelated list transitions, or
repeated polling of an already completed transition. Human Review messages include project, card, Trello URL, pull-request
URL, commit/publication context, review result, remediation result, and, when reliable history is available, the elapsed
workflow time. Completion messages include project, card, Trello URL, and merged pull-request URL. Failed messages include
project, card, Trello URL, failure category and reason, plus the deliberate retry instruction. Refinement messages include
project, card, Trello URL, classification, refined title, and refined description. Attention Required messages include the
project, failure category and reason, affected card IDs when available, session-log paths when available, and
failure-handling outcome when available.

`Attention Required` is diagnostic only. It does not correct or retry cards, and an ambiguous or otherwise unsafe state stays
available for operator investigation and the next reconciliation cycle. It is not sent for shutdown cancellation or for a
card failure already moved to `Failed` through the normal card notification path.

Notification delivery is isolated from workflow state. Existing card-transition email is attempted only after its Trello move
succeeds. A delivery failure is logged with project and card context when available; it does not move a card, replace the
primary workflow error, stop polling, or prevent other enabled handling. A successful refinement still receives its Trello
summary comment when email is disabled or fails.

## Shutdown and fatal errors

`SIGINT` and `SIGTERM` request an idempotent coordinated shutdown. The service stops claiming new cards. Cancellation is
cooperative rather than universal: Trello requests, OpenCode sessions, poll-time setup commands, and SMTP delivery honor the
abort signal, but Git operations and GitHub CLI calls do not currently receive it. An in-flight fetch, rebase, push, or `gh`
command may therefore finish after shutdown is requested, and can delay process exit until its own timeout or completion.
Workers then stop and the process exits successfully. Intentional signal shutdown is not reported as a task failure.

Startup failures, uncaught exceptions, and unhandled promise rejections are logged as fatal diagnostics with the original error
details and a UTC timestamp. The first fatal event requests the same coordinated shutdown and the process exits with status
`1`. Repeated fatal events or signals do not start duplicate cleanup or replace the original fatal diagnostic.

Shutdown does not mark cards successful, advance workflow state, delete recoverable worktrees, or discard agent changes. A
normal failure in one project remains isolated to that project and follows normal card failure or reconciliation handling.

## Logging and retention

Shared `Logger` lifecycle events, warnings, and errors begin with a UTC ISO 8601 timestamp, followed by project and card
context when available and the message. Multiline console logger messages receive the same prefix on every physical line.
At startup, the root logger emits one version event before startup polling begins:

```text
2026-08-30T09:00:00.000Z Agent Orchestrator v0.1.0
```

The version is the `version` value from the application's `package.json`, loaded relative to the built application rather than
from the working directory, environment, or Git. The event uses the normal root `Logger` path, so it appears in both console
output and the managed daily log. Missing or invalid package metadata is a fatal startup error and does not start polling.
Daily files use the existing format:

```text
timestamp level context message
```

They are written under `logs/orchestrator-YYYY-MM-DD.log`; test runs use the `test-orchestrator-YYYY-MM-DD.log` prefix. Raw
command and OpenCode output is written to per-card session logs or forwarded to process standard streams, so it is not
timestamped by the shared logger. Session logs are stored below `logs/sessions/<sanitized-project-id>/<sanitized-card-id>.log`;
path components are sanitized for filesystem use.

`workflow.logRetentionDays` defaults to `14`. Retention cleanup runs at startup and once per day while the service is
running. It applies to managed daily logs and per-card session logs; a file is removed only when its filesystem modification
time is strictly older than the retention cutoff. Missing log directories are ignored. Unrelated files and directories,
symbolic links, and active log files are preserved. Scan and removal failures are logged with their path and reason while
other candidates continue to be processed.

Failed-card session logs remain available until retention removes them. A session log for a card successfully moved to `Done`
is removed immediately on a best-effort basis.

Fatal diagnostics redact configured and environment secret values. Operators should still remove credentials, tokens, private
URLs, and personal data from any shared diagnostic output; see [SECURITY.md](../SECURITY.md).

## Multi-project operation

Multiple projects can be configured in one `config.yaml`. Each project has its own repository, GitHub repository, Trello
board, worktree root, and OpenCode settings. Project workers poll independently and can process independent projects
concurrently.

The one-active-task rule applies per project, not globally. A project with an ambiguous `Working` or active `Human Review`
state is blocked without affecting unrelated projects. A normal card or project failure is logged and reconciled within its
own project; it does not silently advance another project's workflow.

## Safety boundaries

Operators should expect the orchestrator to refuse or stop rather than guess. It does not:

- merge pull requests for projects whose `autoMerge` setting is `false`;
- force-push task branches;
- run agent implementation in the configured source checkout;
- resume a `Working` card without qualifying transition and worktree or pull-request evidence;
- process an active `Human Review` card without actionable requested changes on its expected pull request;
- treat failed external operations as successful workflow transitions;
- silently discard failed agent work; or
- delete arbitrary or unrecognized worktrees.

Use [Recovery](recovery.md) for deliberate retries and ambiguous or interrupted states, and [Workflow](workflow.md) for
the state-transition reference.
