# Operations

[README](../README.md) | [Workflow](workflow.md) | [Configuration](configuration.md) | [Recovery](recovery.md)

This page is the canonical operator reference for execution isolation, publication boundaries, timing, notifications,
shutdown, logging, retention, and multi-project operation.

## Reconciliation block storage

When a retryable GitHub or Trello reconciliation reaches the existing three-attempt limit, the project worker writes its
blocked state to `<contextRoot>/<project-id>/reconciliation-block.json`. This runtime record is below the configured context
root, separate from the configured source checkout and every task worktree, and is written atomically. It stores the project
ID, retry key and exhausted attempt, operation, optional card and reconciliation-list IDs, failure category and reason, the
expected recovery condition, and the notification identities needed to suppress a duplicate alert. Tokens and authenticated
request data are never stored.

On worker startup, a valid block is restored before normal polling. The exhausted operation is not launched as part of restore.
A known-card block performs only the existing lightweight Trello list check and is released when that card is deliberately moved
from its recorded reconciliation list to `Ready for Agent`. Successful recovery removes the block and clears its retry state.
A cardless project block has no card-based check: the external issue must be resolved and an explicit worker restart is the
operator recovery action. Restored notification identity prevents a restart from sending another `Attention Required` alert for
the same unresolved failure. Polling, recovery-check, and notification-delivery failures never remove or overwrite unresolved
block state.

Before repository bootstrap and project reconciliation at startup, the service removes stale atomic-write temporary files for
each configured project. The recognized scope is limited to these writer-generated names:

```text
<worktreeRoot>/.orchestrator/prepared-conflicts/<project-id>/<card-id>.json.<process-id>.tmp
<worktreeRoot>/.orchestrator/trusted-commits/<project-id>/<card-id>.json.<process-id>.tmp
<worktreeRoot>/.orchestrator/rejected-commits/<project-id>/<card-id>.json.<process-id>.tmp
<contextRoot>/<project-id>/.reconciliation-block.json.<process-id>.<unique-suffix>
```

Only regular files whose writer process is no longer running are removed. Missing directories and candidates that disappear
concurrently are harmless. Authoritative state files, malformed authoritative state, directories, symbolic links, unknown
entries, and files from other subsystems are preserved. The cleanup does not scan for arbitrary `.tmp`, dot, JSON, log,
attachment, source-checkout, or worktree files. Inspection or removal failures include the affected path and reason in a
diagnostic and do not stop independent project startup.

Block records are validated at the storage boundary, including strict record shape, non-blank values, optional types,
supported operation and recovery values, and project/card identity consistency. Malformed or mismatched state is retained and
fails closed with an actionable project diagnostic; it is never treated as recovered and never triggers the exhausted operation.
Each project loads its own record, so a blocked or malformed record does not stop independent project workers. Operators should
preserve the file for investigation and repair it only as an explicit runtime-state operation below the configured context root.

### Persisted-state size guard

The reconciliation block, prepared-conflict handoff, trusted committed-implementation record, and rejected-commit record are authoritative JSON state files. Each is
limited by the same fixed 1 MiB upper bound; this is an implementation safety limit, not a configuration option. The service
checks the filesystem byte size before reading a file for JSON parsing. A file above the limit is rejected as malformed state, and
the diagnostic identifies the affected path and size-limit failure without logging its contents.

Oversized files are retained unchanged for diagnosis. A reconciliation block follows the existing malformed-state project-blocking
path. An oversized prepared-conflict, trusted-commit, or rejected-commit record follows its existing recovery error path. Missing
files and ordinary malformed or schema-invalid files behave as before, and no workflow state advances because persisted state was
rejected.

## Card context storage

`workflow.contextRoot` is the workflow-level filesystem boundary for card-specific external context. It defaults to
`/opt/.agent-context` and must be an absolute path separate from every configured source checkout and Git worktree root.
The service never uses the current working directory, a Git repository, or a Git worktree as this default.

When a card context is created, its exact layout is:

```text
<contextRoot>/<project-id>/<card-id>/
<contextRoot>/<project-id>/<card-id>/attachments/
<contextRoot>/<project-id>/<card-id>/attachments.json
```

Before each applicable OpenCode session starts for a card, the current Trello attachment metadata is reconciled into this
directory. Refinement, implementation, automatic review, automatic remediation, and human review-feedback implementation
sessions use the context; commit sessions do not.
Uploaded Trello files are downloaded with Trello authentication under `attachments/`; external URL attachments are never
dereferenced and have no local file. `attachments.json` contains the current attachments in Trello order after a successful
reconciliation:

```json
{
  "attachments": [
    {
      "id": "attachment-id",
      "name": "design.pdf",
      "mimeType": "application/pdf",
      "bytes": "1234",
      "url": "https://trello.com/1/cards/...",
      "isUpload": true,
      "localFilename": "design.pdf"
    },
    {
      "id": "reference-id",
      "name": "Reference",
      "mimeType": null,
      "bytes": null,
      "url": "https://example.com/reference",
      "isUpload": false,
      "localFilename": null
    }
  ]
}
```

`mimeType` and `bytes` retain Trello's nullable and empty values. `localFilename` is a single filename, never a path. Names
are reduced to safe filename components and duplicate names receive stable numeric suffixes. Existing valid files are reused
when all stored Trello metadata matches, so repeated preparation does not download them again. Files not present in the
current Trello response are removed when they are regular files claimed by the previous manifest, including a superseded
file after a replacement is published. Unknown and unrelated context files are retained; the service does not delete
arbitrary files.

After every successful refresh, the existing project- and card-scoped logger emits one concise reconciliation event. Its format is:

```text
Trello attachment context refreshed: reused uploaded attachments: 1; newly downloaded uploaded attachments: 1; removed stale managed attachments: 1; external URL attachments: 1; total current attachments: 3
```

The counts mean:

- `reused uploaded attachments`: current uploads whose stored metadata and existing regular materialized file were reused.
- `newly downloaded uploaded attachments`: new or changed uploads materialized during this refresh.
- `removed stale managed attachments`: regular files claimed by the previous manifest that were removed because they are no longer current, including replaced uploads. Unknown and unrelated files are not counted or removed.
- `external URL attachments`: external attachments in the current Trello response. They are metadata-only and are never downloaded.
- `total current attachments`: all entries in the successfully published current manifest, including uploads and external URLs.

All categories are logged when zero, including for an empty card. A retrieval, validation, download, manifest, filesystem, stale-file, or abort failure emits no successful summary. The card-scoped failure diagnostic identifies attachment context preparation and its reason through the normal failure flow. Attachment contents, response bodies, credentials, authenticated download URLs, and other sensitive request data are not included in attachment summaries or failure diagnostics.

Each new upload is limited to `maxAttachmentBytes`, which defaults to 50 MiB, and all new downloads in one preparation are
limited to `maxTotalAttachmentBytes`, which defaults to 200 MiB. The limits apply to declared metadata, response
`Content-Length`, and streamed bytes, including when a size is unknown or unusable. The optional settings are positive safe
integers in `workflow`. A failed, aborted, over-limit, or filesystem-failed transfer does not publish its final file or a
manifest claiming success, and prevents OpenCode from starting. Existing manifests and managed paths are validated with
`lstat`; malformed manifests, traversal paths, symlinks, and unexpected file types are refused.

When a card has attachments, the refinement, implementation, automatic review, automatic remediation, and review-feedback
remediation prompts include a compact section containing the attachment name, a non-blank MIME type when Trello provides
one, and a usable location. The section is omitted when the card has no attachments. Its format is:

```text
Trello card attachments:
These attachments are part of the Trello task context. Inspect them when relevant.
- design.pdf (application/pdf): local file: /opt/.agent-context/project-id/card-id/attachments/design.pdf
- Reference: external URL: https://example.com/reference
```

Uploaded attachments are represented by the absolute path to the downloaded file. External-link attachments are represented
by their URL and are never dereferenced or assigned a local path. Commit prompts do not include this section. No attachment
contents, excerpts, or other full attachment data are placed in any prompt.

The path is resolved in the filesystem namespace of the running process. In a local deployment, create or grant write
permission to the configured root for the service user. In Docker, configure the same absolute path inside the container and
mount a persistent host or named volume at that container path; permissions and ownership must allow the container process
to create project, card, and attachment directories. A host path that is not mounted at the configured container path is not
the storage location used by the service, and it is not the path shown to OpenCode.

Card context is operational filesystem data, not Git state. It is outside the source checkout and all worktrees, is not
committed or included in task branches, and should be backed up, retained, and access-controlled independently from Git
repositories. Successful attachment reconciliation removes only stale regular files claimed by the prior manifest; it
does not remove unknown files.

The service does not remove card context immediately after a successful, failed, resumed, or retried card. A failed
preparation keeps the last successfully published manifest and its materialized files and removes only partial files created
by that preparation. Stale managed files are cleaned as part of a successful manifest publication. Unknown files remain
available for diagnosis and are never removed as part of attachment reconciliation. Scheduled context retention later removes
the expired card context directory as a unit; there is no separate operator-triggered cleanup command. Any manual cleanup must
be limited to known card-context paths below the configured `contextRoot`.

### Card context retention

`workflow.contextRetentionDays` defaults to `14`. Cleanup runs once during startup and once per day while the orchestrator is
running, and its periodic timer is stopped during shutdown. Expiration uses the card context directory's filesystem
modification time and the cleanup-time cutoff: only a directory strictly older than the cutoff is removed. A directory at the
exact cutoff or newer is retained.

The scanner examines only the configured project directories and their direct card context directories under:

```text
<contextRoot>/<project-id>/<card-id>/
```

It never removes the context root, project directories merely because they are empty, unrelated entries, repositories,
worktree roots, worktrees, or any path outside `contextRoot`. Active cards are protected for the full processing interval,
including attachment reconciliation and OpenCode stages. Missing paths and concurrent removals are harmless; scan,
inspection, and removal failures include the affected path and reason in diagnostics while independent candidates continue.
Symbolic links at managed paths, and symbolic links found inside a candidate context, are skipped without following or removing
them. The configured context root is normalized and each candidate is checked against that boundary.

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
Implementation worktrees remain available while their owned PR is under CI monitoring or Human Review so bounded CI and feedback
repairs can reuse the task branch. After an authoritative terminal PR transition, cleanup is limited to the expected
`<worktreeRoot>/<card-id>` and `agent/<card-id>` artifacts. The terminal mutation remains durable until required cleanup has been
verified; a failure preserves the queue event and task state for restart recovery without repeating a merge or duplicating the
terminal Trello transition. Refinement clears its result and attempts local worktree cleanup after moving the card to `Backlog`.
Result-file and refinement cleanup are housekeeping; failures are warning-level diagnostics with project, card, operation, and
affected path, and do not undo a confirmed `Backlog` transition. Failed or unsafe removals preserve the remaining artifact.

Terminal cleanup is fail-closed. It does not remove symbolic links, paths outside the configured root, nested or unknown
worktrees, unexpected branches, dirty worktrees, worktrees with unmerged paths, or worktrees with an active rebase. A
prepared-conflict handoff also protects its worktree until recovery is complete. An already-absent worktree or local branch
is idempotent. If any safety check or Git removal fails, the remaining artifacts are left for diagnosis where possible;
shutdown cancellation does not start or continue destructive cleanup.

## Publication and GitHub boundaries

### GitHub CLI compatibility

Agent Orchestrator supports GitHub CLI (`gh`) `2.40.0` and later. Startup validates the installed CLI before bootstrapping any
configured repository or beginning Trello project processing. The validation runs `gh --version`, checks the help surface for
the commands and options used by the service, and executes a repository-scoped `gh pr list --json` probe for every dynamic pull
request field used by reconciliation and review handling.

The required command surface is:

| Command         | Required capabilities                                                    |
| --------------- | ------------------------------------------------------------------------ |
| `gh repo clone` | Repository cloning                                                       |
| `gh pr list`    | `--repo`, `--head`, `--base`, `--state`, `--json`, `--jq`, and `--limit` |
| `gh pr create`  | `--repo`, `--base`, `--head`, `--title`, and `--body`                    |
| `gh pr merge`   | `--repo`, `--match-head-commit`, `--merge`, and `--delete-branch`        |
| `gh api`        | `--paginate` and `--slurp`                                               |

The required `gh pr list --json` fields are `url`, `state`, `mergedAt`, `baseRefName`, `headRefName`, `headRepository`,
`headRepositoryOwner`, `mergeable`, `mergeStateStatus`, `number`, `reviewDecision`, and `headRefOid`. The service derives a
head repository's `owner/name` identity from the stable `headRepositoryOwner.login` and `headRepository.name` fields; it does
not depend on the unsupported `headRepositoryNameWithOwner` convenience field.

Capability validation uses the first configured repository and its project-scoped GitHub credentials. Consequently, the
configured repository must be reachable with the selected ambient or GitHub App authentication before normal processing can
begin. Failures identify GitHub CLI compatibility at startup and do not become card-specific reconciliation failures.

GitHub authentication is selected per project at the `repository.githubApp` operation boundary. These are the two supported
modes:

- **GitHub App:** If `repository.githubApp` is configured, the service reads its private key on demand and exchanges an App JWT
  for a short-lived installation token scoped to exactly the project's configured `repository.github` repository. The request
  sends that repository's name, rather than its full `owner/repository` name, in GitHub's `repositories` field. The token is used for the project's repository cloning, GitHub CLI
  pull-request, review, and merge calls, and authenticated `git fetch`, `git ls-remote`, `git push`, and remote-branch deletion.
- **Ambient authentication:** If `repository.githubApp` is omitted, the service leaves ambient GitHub CLI and Git
  authentication unchanged. This supports an authenticated `gh` session and PATs supplied through `GH_TOKEN` or
  `GITHUB_TOKEN`, including other ambient Git authentication.

Successful installation tokens are cached in process memory per App identity, installation, and repository scope, reused until
five minutes before the returned `expires_at`, and then refreshed. Projects using the same App installation but different
repositories never share a completed or in-flight exchange. For Git, a bounded invocation clears configured credential helpers and uses
`GIT_ASKPASS` to read the token from its child environment. The token never appears in command arguments, repository URLs,
logs, session logs, persisted state, or failure diagnostics. Ambient `GH_TOKEN` and `GITHUB_TOKEN` values are used only to redact
child output and failures; the ambient child environment is otherwise unchanged.

App credential resolution is project-isolated and has precedence over ambient credentials. A missing or unreadable private key,
invalid App credentials, failed JWT generation, or failed installation-token exchange fails the affected operation without PAT or
other ambient fallback. Startup clone failures stop startup; workflow failures preserve the card's existing failure/reconciliation
behavior and preserve recoverable worktrees and agent changes. Operators must correct the App configuration or external GitHub
access and retry through the normal workflow; the service does not persist tokens or expiration data. A missing, blank, or invalid
`expires_at` makes the exchange fail and is not cached. An exchanged token is usable only when its parsed `expires_at` is
strictly later than the current time plus the five-minute refresh window; expired, nearly expired, and exact-boundary
responses therefore fail through the safe App exchange error path without being returned or cached.

Immediately before publication, the task worktree fetches `origin/<defaultBranch>` and rebases `agent/<trello-card-id>` onto
that fetched ref. Git leaves an already-current branch unchanged. The resulting `HEAD` drives remote comparison, push
decisions, pull-request publication, notifications, and the Trello summary.

The post-commit AI pull-request-description step is presentation-only. Its strict structured output accepts a summary of at most
1,000 characters, at most 20 `changes` entries and 20 `validation` entries, and at most 500 characters per entry. Empty arrays
remain valid, including `validation` when no result is known. Its context collection, OpenCode execution, structured output
parsing or validation, and Markdown rendering failures, including oversized output, are logged with the failed stage and do not
block publication. New pull requests use the deterministic fallback body, consisting of the Trello card URL followed by the
footer `Implemented automatically by <projects[].repository.gitIdentity.name>.`; generated descriptions use that same footer.
Existing open pull requests are reused without description updates, as usual.

For every open owned PR, the worker verifies the persisted URL, branch, repository, and exact current head before observing CI and
feedback. Checks and commit statuses are matched to automatically established expectations from repository rules and static
workflow contracts. Conditional or dynamic workflows, inaccessible policies, delayed/missing checks, skipped/neutral/cancelled
results, and stale heads remain waiting or uncertain. The worker never uses currently visible green checks as proof that the
expected check set is complete. Only complete failures trigger the bounded primary-session CI repair cycle; only complete passes
can authorize feedback replies or auto-merge.

On review feedback, stable review/thread/comment identities remain in the durable task ledger through remediation and independent
verification. Replies use the original GitHub conversation context and are published only after the correction is committed,
published to the same PR, and fully CI-verified. A repair that produces no change does not mark feedback as addressed. The
orchestrator does not approve reviews, dismiss reviewer decisions, or resolve threads.

The publication rules are:

- A missing remote task branch is pushed with a normal push.
- A remote branch already at the resulting commit is not pushed again.
- A remote branch that is not an ancestor of the resulting commit is rejected because it would require a non-fast-forward
  update.
- Fetch or rebase failure stops before push, pull-request lookup or creation, and the successful `Human Review` transition.
- An existing open pull request is reused; a new pull request is created only when needed.
- Normal publication never force-pushes. A task PR is observed on the exact published head, and auto-merge is deferred until
  local quality gates, independent review, and the complete current-head CI evaluation pass. Pending, failed, unknown, and stale
  CI evidence blocks merge.

If feedback remediation returns no source changes, its feedback remains unverified in the task ledger. The orchestrator does not
commit, publish, reply with a success claim, or move the card to `Done` based on a no-op result; the existing PR and worktree remain
available for further review or operator attention.

The task worktree and branch are preserved after fetch, rebase, publication, CI, or merge failures so conflicts and diagnostics
can be resolved. With `autoMerge: false`, a human must merge the pull request before the card reaches `Done`. With
`autoMerge: true`, the unified worker merges only after complete current-head CI and local evidence pass.

Prepared-publication conflicts follow the preservation boundary and never create a replacement pull request. A conflict is left
in place for dedicated handling without automatic abort, reset, clean, worktree removal, or recreation. A validated handoff keeps
task/base identity, the trusted pre-rebase commit, target, paths, and current rebase metadata. The dedicated OpenCode remediation
session runs in the same isolated worktree and may continue every conflict stop; the agent does not control commits, pushes, or PRs.

The coordinator verifies a completed rebase, clean worktree, correct branch, and trust evidence before continuing normal local
quality review and publication. Failure, timeout, permission denial, unresolved conflict, or uncertain identity retains the handoff
and worktree for operator attention. A blocked worker checks only the persisted handoff and Git conflict state; a valid completed
rebase releases the block for the next normal task-session quality/publication gates. A missing or malformed handoff remains blocked.

### Rewriting an owned task branch

The `GitClient.pushWithLease` helper is the only supported operation for publishing a caller-rewritten task branch. It may
be used only for the exact `agent/<card-id>` branch convention. Before calling it, the caller must resolve the authoritative
current SHA of that remote branch, for example with `git ls-remote`; a local tracking ref is not sufficient. The supplied SHA
is placed in an exact `refs/heads/<branch>:<sha>` `--force-with-lease` option.

Git performs the lease check at push time. If the branch changed after the authoritative lookup, or disappeared, the push
fails and does not overwrite remote state. The helper propagates that failure, so callers must not report a successful update
or advance workflow state after a rejected lease. It uses the same project-scoped GitHub App askpass credentials or ambient
Git/PAT authentication as normal Git operations, and credentials are never command arguments. Unrestricted `--force` and
unscoped `--force-with-lease` pushes remain unavailable.

## Elapsed workflow time

When a refinement card is successfully moved to `Backlog`, its concise Trello completion comment can contain:

```text
Agent Orchestrator completed refinement.

Classification: improvement
Refined task title: Add inventory support
Elapsed workflow time: 1 hour 5 minutes
```

For refinement, the timer starts at the current pass's `Ready for Agent` to `Working` transition, or at `Failed` to `Ready
for Agent` for a deliberate retry. It ends at that pass's successful `Working` to `Backlog` transition. The comment omits the
elapsed-time line when that transition history is missing, incomplete, malformed, ambiguous, or has invalid date ordering;
the reason is logged and the successful `Backlog` state is preserved.

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

| Event                | Sent when                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `humanReview`        | A card successfully enters `Human Review` after normal publication or reconciliation                                   |
| `failed`             | A card successfully enters `Failed` through automated failure handling                                                 |
| `refinementComplete` | A refinement card successfully enters `Backlog`                                                                        |
| `done`               | A merged pull request successfully moves its card to `Done`, whether it was merged by a human or auto-merged           |
| `attentionRequired`  | A project poll or reconciliation cannot safely continue after any bounded retry, including ambiguous active-card state |

The service does not notify for cards merely observed in `Human Review`, `Failed`, or `Done`, unrelated list transitions, or
repeated polling of an already completed transition. Human Review messages include project, card, Trello URL, pull-request
URL, commit/publication context, review result, remediation result, and, when reliable history is available, the elapsed
workflow time. Completion messages include project, card, Trello URL, and merged pull-request URL. Failed messages include
project, card, Trello URL, failure category and reason, plus the deliberate retry instruction. Refinement completion emails
include project, card, Trello URL, classification, refined title, and, when reliable history is available, elapsed workflow time;
they do not include the refined description. The corresponding Trello comment is the concise summary described above. Attention
Required messages include the project, failure category and reason, affected card IDs when available, session-log paths when
available, and failure-handling outcome when available.

Failure reasons and failure-handling outcomes in failed-card comments, failed emails, `Attention Required` emails, and project
failure diagnostics use one fixed 2,000-character maximum per externally derived value. Values above the maximum end with the
deterministic `... [truncated]` marker; fixed retry or recovery guidance and available session-log references remain present.
Existing secret redaction occurs before this bound is applied. This limit affects concise presentation surfaces only. The complete
redacted command and OpenCode output remains in the retained per-card session log for investigation.

Closing an expected pull request without merging moves its Human Review card to `Backlog` and adds a Trello explanation with
the pull-request URL; it does not send the `failed` event. A failed Backlog move is retained as a reconciliation diagnostic,
while a comment failure after a successful move is logged and leaves the card in `Backlog`.

`Attention Required` is diagnostic only. It does not correct or retry cards, and an ambiguous or otherwise unsafe state stays
available for operator investigation, but an exhausted reconciliation operation is blocked instead of being retried on every
poll. Recognized GitHub `UNKNOWN` mergeability and merge-state responses are temporary unresolved states during Human Review;
they use the existing three-attempt card-scoped retry and backoff, with `Attention Required` emitted only after exhaustion.
Malformed or unsupported merge-state data remains an immediate diagnostic. Trello and GitHub operations classify HTTP 500, 502, 503, 504, rate limits, timeouts, and temporary connectivity
failures as retryable. The project worker logs each failed attempt with project, card when known, operation, classification, safe
error context, and a deterministic `1/3`-style count; it sends no attention event until three consecutive attempts fail. After
the external failure is resolved, moving a known affected card from its recorded reconciliation list to `Ready for Agent` is the
explicit recovery condition; the worker then clears that operation's transient counters and resumes. Project-level failures
without a card identity require an explicit worker restart after resolution. Transient Trello reads never infer that a card is
missing or invalid. Transient Trello mutations leave the last known card state unchanged or unconfirmed and never move a card to
`Failed` solely for the transient error; reconciliation determines whether the uncertain move took effect. Authentication,
configuration, malformed-response, not-found, and other non-transient errors still use immediate diagnostics. This policy does
not add automatic retries for cards already in `Failed`. It is not sent for shutdown cancellation or for a card failure already
moved to `Failed` through the normal card notification path.

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
Retryable Trello and GitHub reconciliation attempts are warnings and include the affected operation and bounded attempt count;
exhausted attempts are logged as project errors before the existing failure diagnostic and attention notification. Trello request
errors retain operation, status, retry classification, and the underlying error as structured context without logging tokens,
authenticated URLs, or response bodies.
Daily files use the existing format:

```text
timestamp level context message
```

They are written under `logs/orchestrator-YYYY-MM-DD.log`; test runs use the `test-orchestrator-YYYY-MM-DD.log` prefix. Raw
OpenCode and command output is written to per-card session logs or forwarded to process standard streams, so it is not
timestamped by the shared logger. Configured repository validation is captured in the relevant OpenCode card session log. Clean
Human Review branch maintenance does not run the configured validation command. Session logs are stored below
`logs/sessions/<sanitized-project-id>/<sanitized-card-id>.log`; path components are sanitized for filesystem use. Validation
failures reported by an agent are concise diagnostics with a session-log reference; the complete redacted stdout and stderr remain
in that per-card log instead of being dumped to the service log.

Vitest suppresses shared logger console output by default while retaining the daily test log. Temporarily enable application
logger output for a debugging run with `TEST_LOGS=true yarn test`.

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

## Unified task-session operation

Every configured project runs the same durable task-session workflow; there is no per-project mode switch or required-check-name
list. Configure the required `repository.validationCommand`; `coverageCommand` remains optional and becomes a gate when set. CI
expectations are discovered from branch-protection information and repository-owned pull-request workflows. See
[Configuration](configuration.md#ci-expectation-discovery) for how unknown and dynamic CI contracts fail closed.

Task plans, execution records, feedback ledgers, and mutation queues are stored under workflow `contextRoot`, outside the
repository and worktrees. Preserve this runtime data across restarts and include it in operational backups. Do not hand-edit
or remove a task record, ledger, or queue event to clear a failure. The queue persists event identity and permits only one active
repository-mutating operation per project. A project can monitor multiple owned waiting PRs read-only; any implementation,
refinement, CI repair, feedback remediation, or terminal PR reconciliation waits for the single project mutation owner.
Independent projects retain their separate workers and may proceed concurrently.

Mutation events record their active worker identity. A recovery claimant does not take an event from another live worker; after a
worker exits, it can reclaim only the task's matching persisted event after authoritative ownership and worktree checks pass.
Repeated polling with a changed card operation identity does not reuse an old event. A failed pre-`Working` claim can resume its
prepared owned worktree only when the original queue identity still matches.

A queued event does not mutate a repository. A failed or uncertain event retains queue ownership until the workflow verifies
recovery; it blocks later mutations for that project rather than being discarded or automatically retried. Preserve its record,
inspect the affected task and external state, and follow the task-session recovery guide before resuming.

Validation repair, independent review repair, and CI repair each have a finite limit of two attempts per cycle. Complete CI
failures are collected together; pending or uncertain expected checks remain waiting without consuming repair attempts. Local
gates and review are rerun after each correction. `autoMerge` defaults to `false`; when enabled it still requires complete
current-head CI and passing local evidence. Exhaustion or ambiguous state is preserved for operator attention rather than retried
indefinitely. Replies are published only for independently verified items after the correcting commit and a complete passing CI
result. The process does not approve reviews or resolve reviewer threads. See [Workflow](workflow.md#unified-task-lifecycle) and
[Recovery](recovery.md#task-session-recovery) for lifecycle and recovery details.

The unified implementation has been verified locally with mocked Trello, GitHub, and OpenCode boundaries. This does not establish
that a particular GitHub check, permission, Trello board, or OpenCode runtime is available. No real-world pilot, deployed-service
test, or live API verification has been performed; those checks remain separate operator decisions.

## Safety boundaries

Operators should expect the orchestrator to refuse or stop rather than guess. It does not:

- merge pull requests for projects whose `autoMerge` setting is `false`;
- use unrestricted force-pushes or unscoped force-with-lease pushes;
- run agent implementation in the configured source checkout;
- resume a `Working` card without qualifying transition and worktree or pull-request evidence;
- mutate an open `Human Review` task without actionable feedback on its expected pull request;
- treat failed external operations as successful workflow transitions;
- silently discard failed agent work; or
- delete arbitrary or unrecognized worktrees.

Use [Recovery](recovery.md) for deliberate retries and ambiguous or interrupted states, and [Workflow](workflow.md) for
the state-transition reference.
