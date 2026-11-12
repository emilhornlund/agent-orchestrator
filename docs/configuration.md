# Configuration

[README](../README.md) | [Workflow](workflow.md) | [Recovery](recovery.md) | [Operations](operations.md)

This page is the canonical reference for `config.yaml`, `config.example.yaml`, environment variables, defaults, and
startup validation. [`config.example.yaml`](../config.example.yaml) is an illustrative two-project configuration with
placeholder IDs and paths. Copy it to the ignored local `config.yaml` and replace those values; do not commit `config.yaml`
or `.env`.

## Files and startup

Create the local files from the repository root:

```bash
cp config.example.yaml config.yaml
cp .env.example .env
```

The service loads `config.yaml` and then validates the process environment. A missing file, invalid YAML, unknown strict
field, blank required value, or invalid value is a startup error. Configuration parsing reports repository-relative field
paths such as `projects.0.repository.path`.

Before housekeeping, repository bootstrap, or project processing begins, startup requires Git `2.30.0` or later, OpenCode
`1.0.0` or later, and GitHub CLI (`gh`) `2.40.0` or later. Git/OpenCode version output and the OpenCode `run` options
consumed by this service are probed locally; gh version and enabled command help capabilities are also checked. A missing,
inaccessible, malformed, unsupported, or capability-incomplete executable is a fatal startup error with a local remediation
message. These are executable compatibility checks, not project authentication/resource checks: gh does not contact the first
configured repository during compatibility validation. Trello/GitHub resource validation remains project-scoped and separate.

## Environment variables

The following variables are always required:

```dotenv
TRELLO_API_KEY=
TRELLO_TOKEN=
```

When `notifications.email.enabled` is `true`, the names in `notifications.email.smtp.usernameEnv` and
`notifications.email.smtp.passwordEnv` identify two additional required environment variables. Their values are the SMTP
credentials and must not be put in YAML. When email is omitted or disabled, those SMTP variables are not required.

For projects that omit `repository.githubApp`, GitHub authentication may come from an authenticated `gh` session or ambient
Git credentials. Operators using a PAT may supply it through the optional `GH_TOKEN` or `GITHUB_TOKEN` environment variable;
`GH_TOKEN` is included as an optional PAT example in [`.env.example`](../.env.example). Neither variable is globally required,
and PAT environment variables are unnecessary for projects using a GitHub App.

`.env` is ignored by the repository. Keep Trello credentials, SMTP credentials, API keys, access tokens, and other secrets
out of configuration files and source control.

## Top-level settings

### `projects`

`projects` is a non-empty list. Each item has `id`, optional legacy `autoMerge: false`, optional `maintenance`, `trello`, `repository`, and `opencode` settings. Project IDs
must be unique.

### `workflow`

`workflow` is required and contains:

| Key                       | Meaning and validation                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pollIntervalSeconds`     | Optional positive integer interval between project polling cycles; defaults to `15`                    |
| `maxConcurrentAiProjects` | Optional positive safe integer limit on configured projects executing AI work; omitted means unlimited |
| `logRetentionDays`        | Positive integer number of days for managed log retention; defaults to `30` when omitted               |
| `contextRetentionDays`    | Positive integer number of days for card context retention; defaults to `14` when omitted              |
| `contextRoot`             | Optional absolute root for card context; defaults to `/opt/.agent-context`                             |
| `coordinationRoot`        | Required absolute host-visible directory for canonical project ownership coordination                  |
| `coordinationNamespaceId` | Required identity of the explicitly provisioned coordination namespace                                 |
| `maxAttachmentBytes`      | Optional positive safe integer per-upload limit in bytes; defaults to 50 MiB                           |
| `maxTotalAttachmentBytes` | Optional positive safe integer aggregate new-download limit in bytes; defaults to 200 MiB              |

AI capacity is separate from project task ownership. An idle open PR still blocks that project's next task but consumes no AI
slot. Dependency/recovery waits do not consume a slot after execution is verified stopped. Ready projects acquire capacity in
durable first-come, first-served order; a busy project requeues behind existing waiters. Shutdown retains unserved tickets for
restart. Unknown process liveness retains occupied capacity until stopped-execution evidence is established; PID absence alone
does not release it. Nested activities for the owning project reuse the current slot.

`contextRoot` and `coordinationRoot` are normalized with `path.resolve` like the other configured absolute paths. A custom value must be non-blank
and absolute. The root must not equal, contain, or be contained by any configured `projects[].repository.path` or
`projects[].repository.worktreeRoot`, including after normalization. Unknown `workflow` keys are rejected.

Configure `coordinationRoot` and `coordinationNamespaceId` for every production run. The directory must be explicitly created with protected
ownership/permissions and provisioned with the versioned `.agent-orchestrator-coordination.json` marker before acquisition; the
coordination API never creates an arbitrary root or marker. Every local/container participant must mount the **same host directory**
at its configured runtime path and use the same namespace ID. A copied marker in independent directories is not shared coordination.
Operators must establish and verify this common-mount contract; isolated namespaces hidden from each other cannot be discovered by
the application. Startup acquires canonical project ownership before housekeeping/bootstrap and records project integration,
Trello resource, repository, worktree, and context-storage pins in the host registry. A removed or redirected pinned project must
be explicitly reconciled; do not delete registry evidence to bypass the check.

### Provisioning a shared host coordination namespace

An administrator must create the `/var/lib` parent hierarchy and grant the dedicated service account ownership of its
application directory; an unprivileged service account cannot create arbitrary entries directly under `/var/lib`. Do not
grant the service account broad system privileges just to provision this path. Run namespace setup below as the service
account (replace the path and namespace ID consistently in every participant's configuration). Do not place it under a
repository. The namespace directory is private to that runtime UID; a rootless container must use a compatible UID mapping.
Provisioning refuses an existing marker. Run `node --import tsx` from the application checkout with the declared `tsx`
dependency installed. The working directory matters for package resolution. Use a dedicated service account and compatible
Podman `--userns=keep-id` mapping rather than broadening namespace permissions.

```sh
SERVICE_USER=agent-orchestrator
SERVICE_GROUP=agent-orchestrator
sudo install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 /var/lib/agent-orchestrator
```

Then, from the application checkout as the service account:

```sh
set -eu
export COORDINATION_ROOT=/var/lib/agent-orchestrator/coordination
install -d -m 0700 "$COORDINATION_ROOT"
test "$(stat -c %u "$COORDINATION_ROOT")" = "$(id -u)"
node --import tsx --input-type=module -e 'import { provisionCoordinationNamespace } from "./src/coordination/project-ownership.ts"; provisionCoordinationNamespace(process.env.COORDINATION_ROOT, "host-prod-v1")'
```

`set -eu` makes any failed install, ownership check, or provision command stop setup; do not start the service if provisioning
fails. The administrator-owned parent-directory step may instead be performed by the host's normal service-account
provisioning system.

For Podman, mount that exact host directory read/write. A non-root container must use a compatible host UID mapping; do not
make the namespace group/world writable to work around a mapping mismatch. Do not use `:Z` or `:z` when the same namespace is
shared with host processes or other containers: relabeling can make an otherwise shared host directory inaccessible to peers.
Do not use `--security-opt label=disable` for production as a substitute for a deliberate SELinux policy. Have the host
administrator configure SELinux policy so the host service identity and the compatible container domain can access the same
existing namespace label. Do not privately relabel a shared namespace or the source checkout. Runtime paths may differ: for example, configure
the host as `/var/lib/agent-orchestrator/coordination` and a container as `/run/agent-orchestrator/coordination`, with the
host directory mounted at the latter path. The contents must be the same mount, not copies. For example:

```sh
podman run --rm --userns=keep-id -v "$COORDINATION_ROOT:/run/agent-orchestrator/coordination:rw" IMAGE
```

The supplied production image runs compiled JavaScript from `/app`; it does not need
an application source mount or `tsx`. See [installation](operations.md#local-and-container-installation)
for image building, configuration and persistent mounts. Use the same namespace ID
in every participant. A container that cannot access the marker/owner files fails startup
before project processing; do not work around that failure by making the namespace writable by everyone.

Writable OpenCode execution additionally requires Linux Bubblewrap (`bwrap`). Install
it in the runtime image as well as on local hosts (for example, the distribution's
`bubblewrap` package). Startup probes the actual mount/PID namespace capability as
the service user before processing tasks. Container seccomp, user-namespace and
SELinux policies must permit this bounded nested isolation; installing the binary
alone is insufficient. Keep these policies explicit and least-privilege: do not
use privileged containers or disable SELinux labeling as a workaround. A denied
probe fails startup with an actionable isolation error, without claiming a task.
The probe mounts the host read-only only to execute `/bin/true`; agent dispatch
instead mounts explicit tool/configuration dependencies, read-only Git/runtime
context and the owned writable task content, never the whole host root.

The volume may be bind-mounted at different absolute paths in host and container. Active attempt state itself remains pinned
to its configured storage root; changing that root during an active attempt is not an equivalent alias. Stop and verify all
old-version workers before enabling a version that understands this namespace: old binaries do not participate in these leases,
and the lease cannot retroactively fence them. Distinct namespace IDs/hidden mounts are an operator deployment error that
cannot be detected from either isolated mount. Multiple-machine coordination is not supported.

If termination is ambiguous and a durable ambiguity marker cannot be published, the service emits one sanitized operator-required warning,
continues controlled marker-publication retries, and remains alive with the integration locks held. Normal bootstrap/shutdown completion must
not release those locks until every marker has been synced. A successful retry permits orderly shutdown while the marker continues to block
reacquisition pending operator recovery. This is a fail-closed guarantee for normal process operation, not an immunity to `SIGKILL`, runtime
crash, power loss, or host failure: those can close descriptors before the marker is durable. In that case an operator must independently
verify the recorded process group and preserved evidence before recovering or clearing coordination state.

Card context storage uses this layout, with project IDs, card IDs, and attachment filenames treated as untrusted single path
components:

```text
<contextRoot>/<project-id>/<card-id>/
<contextRoot>/<project-id>/<card-id>/attachments/
<contextRoot>/<project-id>/<card-id>/attachments.json
```

Before each applicable OpenCode session starts for a card, the service reconciles Trello's current attachments into
`attachments.json` and downloads only `isUpload: true` files into `attachments/`. External URL attachments are retained as metadata with
`localFilename: null`; their URLs are never requested. Uploaded entries contain a safe single-component `localFilename`.
`mimeType` and `bytes` retain nullable and empty Trello values. Initial, resumed, and deliberate-retry implementation paths
prepare context before their implementation session. Each automatic review refreshes it immediately before the review, and
each automatic remediation pass refreshes it before its remediation session. A retry that reuses already committed work skips
all OpenCode stages and does not need an attachment-dependent prompt.
Repeated preparation reuses an unchanged upload when its
stored metadata and regular local file match. A successful reconciliation removes regular files claimed by the previous
manifest for attachments removed from Trello or replaced uploads. Unrelated or unknown files in `attachments/` are retained.

The default per-upload limit is 50 MiB and the default aggregate new-download limit is 200 MiB. `maxAttachmentBytes` and
`maxTotalAttachmentBytes` can override those defaults with positive safe integers. Limits apply to declared Trello sizes,
response `Content-Length`, and actual streamed bytes; unknown or unusable sizes are still bounded. A failed or partial
download leaves no manifest entry claiming success and stops the card before OpenCode. The previous successfully published
manifest and its files remain in place after a failed refresh; stale managed-file cleanup is committed only with successful
manifest publication. Malformed manifests, unsafe paths, symbolic links, and unexpected file types are rejected. The storage helpers
create directories and enforce the same path boundary, but do not change Trello data.

When attachments exist, the refinement, implementation, automatic review, automatic remediation, and review-feedback
remediation prompts include a compact attachment section with each name, each non-blank Trello MIME type, and its location. Uploaded files are
listed as absolute paths resolved in the configured runtime namespace, for example
`/opt/.agent-context/<project-id>/<card-id>/attachments/<localFilename>`. External-link entries are listed as their
external URLs and never have a local path. Cards without attachments have no attachment section. The section contains
metadata and locations only; ordinary commit prompts remain unchanged. Confirmed-loss
primary-session reconstruction is a separate context path and may inline bounded,
sanitized supported text content in its external recovery bundle. This exception does
not establish universal attachment-format support or permit raw secret persistence.

The path shown to OpenCode is in the filesystem namespace of the running service and OpenCode process. In a containerized
deployment, the configured `contextRoot` must be mounted at the same absolute container path; a host path that is not
mounted there is not the runtime location and is not advertised to the agent. If materialized manifest data or an uploaded
file cannot be safely resolved, the workflow reports the affected card context error and does not start the OpenCode session.

Attachment files and manifest metadata remain outside repositories and Git worktrees.
The service retains context after successful and failed processing, including for resumed and retried cards, until scheduled
retention cleanup expires the card context directory. After successful reconciliation, stale regular files claimed by the prior
manifest are removed, while unknown and unrelated files remain. Partial files from a failed preparation are removed, while
the previous successfully published manifest and its materialized files are preserved for diagnosis and retry.

Context retention cleanup runs once during startup and once per day while the orchestrator continues running. A card context
directory is removed only when its filesystem modification time is strictly older than the cutoff calculated at cleanup time;
the exact cutoff and newer directories are retained. Cleanup scans only configured project directories and their direct card
context directories below `contextRoot`. It never removes `contextRoot`, an empty project directory, unrelated entries, or
anything in a source repository or Git worktree. Active cards are protected while their context is being reconciled or used by
an OpenCode workflow stage. Missing paths and concurrent removals are treated as no-ops, and symbolic links are skipped without
following their targets. Scan, inspection, and removal failures are logged and do not stop independent contexts from being
processed.

### `notifications.email`

The whole `notifications` section and its `email` child are optional. Omit the section or set `enabled: false` to disable
all email delivery without requiring SMTP configuration. `enabled` defaults to `false`.

When enabled, the following fields are required, except for `smtp.timeoutSeconds`, which is optional and defaults to `30`:

| Key                   | Meaning and validation                                                              |
| --------------------- | ----------------------------------------------------------------------------------- |
| `recipients`          | At least one valid recipient email address                                          |
| `from`                | Valid sender email address                                                          |
| `smtp.host`           | Non-blank SMTP hostname                                                             |
| `smtp.port`           | Integer from `1` through `65535`                                                    |
| `smtp.secure`         | Boolean; `true` uses implicit TLS, `false` requires a STARTTLS upgrade              |
| `smtp.usernameEnv`    | Non-blank environment-variable name for the SMTP username                           |
| `smtp.passwordEnv`    | Non-blank environment-variable name for the SMTP password                           |
| `smtp.timeoutSeconds` | Optional positive integer connection and delivery timeout; defaults to `30` seconds |

The optional `events` map controls the existing notification types. Its accepted keys are `humanReview`, `failed`,
`refinementComplete`, `done`, and `attentionRequired`; values must be booleans. Every event omitted from the map defaults to
`true`. Unknown event keys are rejected at startup. Delivery behavior and message boundaries are described in
[Operations](operations.md#notifications).

## Project settings

### `projects[].id`

Non-blank identifier used to distinguish projects in configuration and logs. It must be unique; duplicate IDs are rejected
during startup before repository or Trello bootstrap.

### `projects[].autoMerge`

Legacy compatibility setting. Omit it or set it to `false`; `true` is rejected during configuration loading with an actionable
error. The orchestrator never merges pull requests. An open pull request remains in `Human Review` until a human merges or closes
it; approval, passing CI, and local quality evidence do not complete the task. The value must be a boolean when supplied.

### `projects[].maintenance`

Optional per-project toggle for automatic maintenance of outdated pull requests in `Human Review`:

```yaml
maintenance:
  enabled: true
```

Maintenance runs automatically when this block is omitted; `enabled` defaults to
`true`. Explicit `false` disables new routine maintenance, not reconciliation of an
already-started operation. Approved but still-open PRs remain eligible. Human work
and CI repairs have priority over routine maintenance in the project queue.

Published branches incorporate target changes with additive merge commits and
ordinary pushes. Existing published commit identities are retained. Conflict
assistance reuses the primary task session and the bounded remediation maximum;
validation and independent review remain advisory. Available safe updates publish
to the same PR as draft with current diagnostics and pending CI disclosed.
Dirty unstaged setup/untracked output is retained and excluded; staged unrelated
output or unknown local-only commits block automatic inclusion without discarding
anything. Legacy rebase/prepared-conflict records and uncertain pushes are not
reinterpreted as merge permission. Preserve their refs, objects and worktrees for
reconciliation. No rebase, force-push, reset or automatic PR merge is enabled.

### CI expectation discovery

There is no manually configured list of required check names. The orchestrator combines available branch-protection check
contracts and static repository-owned pull-request workflow contracts, then observes all check runs and commit statuses on the
current PR head. Pending, missing, queued, failed, cancelled, skipped, neutral, stale, malformed, dynamic, or unsupported evidence
never counts as success. If workflow conditions or unavailable policy make the expected set unknown, the task waits with an
explicit diagnostic or fails closed. The current visible checks are never assumed to be the complete set.

### `projects[].trello`

All of the following are non-blank Trello IDs:

| Key                  | Meaning                                             |
| -------------------- | --------------------------------------------------- |
| `boardId`            | Board containing the workflow                       |
| `backlogListId`      | `Backlog` list                                      |
| `readyListId`        | `Ready for Agent` list from which cards are claimed |
| `workingListId`      | `Working` list                                      |
| `reviewListId`       | `Human Review` list                                 |
| `failedListId`       | `Failed` list                                       |
| `doneListId`         | `Done` list                                         |
| `refinementLabelId`  | Label that selects refinement                       |
| `featureLabelId`     | Feature classification label                        |
| `improvementLabelId` | Improvement classification label                    |
| `bugLabelId`         | Bug classification label                            |

The six list IDs must be unique within a project, and the four label IDs must be unique within a project. At startup, each
list must exist and be open on its configured board; each label must exist on that board. Each configured project must use a
different Trello board.

The configured list and label names do not matter to the service. The IDs are what it validates and uses.

### `projects[].repository`

| Key                 | Meaning and validation                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `path`              | Absolute path to the normal local checkout; repository paths must be unique across projects                    |
| `github`            | GitHub repository in `owner/repository` format; repositories must be unique across projects                    |
| `defaultBranch`     | Non-blank base branch for task branches and pull requests                                                      |
| `worktreeRoot`      | Absolute directory for isolated task worktrees; roots must be unique across projects                           |
| `setupCommand`      | Optional non-blank command executed by the orchestrator in the card worktree before agent work                 |
| `validationCommand` | Optional non-blank command run by the orchestrator in the owned worktree and bound to the source content       |
| `coverageCommand`   | Independently optional non-blank command; the orchestrator records its observed exit status and source content |
| `gitIdentity`       | Required identity used by the commit session                                                                   |
| `githubApp`         | Optional GitHub App identity used for all authenticated GitHub operations for this project                     |

`path`, `worktreeRoot`, and an optional `gitIdentity.signingKey` must be absolute paths. Parsed absolute paths are resolved
before use. A project's normalized `path` and `worktreeRoot` must be disjoint: neither may equal, contain, or be contained
by the other. This prevents generated worktrees such as `<worktreeRoot>/<trello-card-id>` from entering the normal checkout
or its directory tree. Sibling directories and names that merely share a textual prefix remain valid. This boundary is
checked during configuration loading, before repository bootstrap or project processing begins. `gitIdentity` contains:

| Key          | Meaning and validation                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| `name`       | Non-blank commit author, committer, and pull-request attribution name                                      |
| `email`      | Valid commit author and committer email address                                                            |
| `signingKey` | Optional absolute path to the SSH signing key; it must be available where the service runs when configured |

`setupCommand` and `validationCommand` are separate workflow contracts and may be configured together. `setupCommand` runs
through the command runner in the task worktree before implementation or refinement.
Setup dispatch/result and independent before/after effects are persisted; verified
completion may be skipped on recovery, while unknown execution cannot be blindly
repeated. Relevant setup changes require content-bound agent disposition before task
commit; unrelated output is preserved and excluded, including during existing-PR
corrections. Failed setup cannot start the affected agent.

The orchestrator executes configured quality commands and binds results to exact
content. Validation and coverage are independently optional; an absent command is
reported as skipped, not passed. Quality checks and plan/review feedback are advisory
on initial implementation, feedback, CI repair and maintenance paths. Failed checks
or material unresolved issues require accurate draft publication, not approval.
Operational safety and primary-execution recovery remain mandatory.

#### GitHub authentication modes

GitHub authentication is selected independently for each project at the `repository.githubApp` boundary. These are the two
supported modes:

- **GitHub App:** When `repository.githubApp` is configured, the project's authenticated GitHub operations use a short-lived
  installation token scoped to exactly the configured `repository.github` repository.
- **Ambient authentication:** When `repository.githubApp` is omitted, the service leaves the existing GitHub CLI and Git
  authentication available. This supports an authenticated `gh` session and PATs supplied through `GH_TOKEN` or
  `GITHUB_TOKEN`, as well as other ambient Git authentication.

`githubApp` is an optional strict object containing:

```yaml
githubApp:
  appId: "123456789"
  installationId: "987654321"
  privateKeyPath: "/absolute/path/to/github-app-private-key.pem"
```

All three fields are required when `githubApp` is present. `appId` and `installationId` must be non-blank identifiers, and
`privateKeyPath` must be a non-blank absolute path; absolute paths are normalized before use. Unknown keys and invalid or
incomplete values are rejected during startup. The private-key file is not read by configuration loading. Callers can use the
GitHub App authenticator to read the PEM key on demand, create an App JWT, and exchange it for a short-lived installation
access token. The exchange request includes only the configured repository name in the GitHub `repositories` field, for example
`{"repositories":["repository"]}` for the configured `owner/repository` repository. A successful token and its `expires_at` value are retained only in process memory;
the token is reused until five minutes before expiration, then refreshed. Cache entries include the App ID, installation ID,
private-key path, and repository scope, and are not shared across different App configurations, installations, or repositories.
An exchanged token is usable only when its parsed `expires_at` is strictly later than the current time plus the five-minute
refresh window; expired, nearly expired, and exact-boundary responses fail without being returned or cached.
The private key, JWT, token,
and expiration data are not logged, persisted, or included in configuration. The resolved token is supplied only through a
child-process environment for the bounded operation that needs it: `gh repo clone`, other
GitHub CLI pull-request and review operations, and `git fetch`, `git ls-remote`, `git push`, or remote-branch deletion. Git
temporarily clears configured credential helpers and obtains the token through `GIT_ASKPASS`; it is not placed in command
arguments or repository URLs. If an App is configured, that App mode takes precedence for the project. A missing or unreadable
private key, invalid App credentials, a JWT generation failure, or an installation-token exchange failure fails the affected
operation. None of these failures trigger a fallback to PAT or other ambient authentication. The App is configured at the
project boundary, so its credentials are not shared with another project.

When `githubApp` is omitted, the orchestrator retains ambient GitHub authentication
for GitHub CLI and Git operations. Ambient `GH_TOKEN` and `GITHUB_TOKEN` are allowed
only in those child-process families and are registered for output redaction; they
are not forwarded to setup, validation or OpenCode processes.
`GH_TOKEN` is therefore optional and is needed only when an operator chooses PAT-based ambient authentication. It is not
required for projects using a GitHub App.

### `projects[].opencode`

Each activity accepts optional non-blank `model` and `variant` selections. Omit either setting independently to let OpenCode use its own configured default; the orchestrator does not substitute another model or variant.
When a default-provider environment credential is needed, the orchestrator scopes it using the provider in the operator-owned OpenCode config. It does not inspect task worktree configuration or forward unrelated provider credentials. If it cannot resolve that provider safely, the run fails with an actionable config/auth diagnostic; authenticate the default provider through OpenCode's auth store or configure its default model.

When model selection is omitted, explicit `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`
and `XDG_CONFIG_HOME` locations must be absolute: the service and task process have
different working directories. The selected config/XDG root does not fall back to a
displaced home config to select credentials. This resolves credential scope only;
the omitted model/variant flags still leave actual selection to OpenCode. Scripted
argument/environment tests alone do not demonstrate a live provider's effective default.

| Stage            | Used for                                                           |
| ---------------- | ------------------------------------------------------------------ |
| `refinement`     | Refining a Trello task and classifying it                          |
| `planning`       | Creating the task-session plan                                     |
| `implementation` | Initial implementation and implementation of human review feedback |
| `review`         | Independent review pass                                            |
| `planReview`     | Independent verification of the task-session plan                  |
| `remediation`    | Addressing review findings; includes the automatic pass limit      |
| `commit`         | Final commit and post-commit pull-request-description sessions     |

`projects[].opencode.timeoutMinutes` is the positive maximum runtime in minutes for an individual OpenCode execution at any
stage. It defaults to `360` when omitted.

The post-commit pull-request-description session reuses the configured `commit` model and variant. There is no separate
description-model configuration. The orchestrator supplies the card title, description and URL, final changed files, commit
information, and known validation or test results. The description result is strict JSON with `summary`, `changes`, and
`validation` fields. Missing or invalid output, OpenCode execution failure, or Markdown rendering failure is logged as a
non-critical description-generation failure and falls back to a deterministic body
with task purpose, available changed files, observed quality results, outstanding
issues, Trello URL and the configured attribution footer
`Implemented automatically by <projects[].repository.gitIdentity.name>.`; it does not block branch publication, pull-request creation, reuse, or card
transitions. A valid empty `validation` array is allowed and does not claim that validation or tests passed. The result is
generated after publication preparation. A standalone deterministic renderer defines the Markdown contract: fixed `Summary`,
`Changes`, `Validation`, and `Task` sections, an application-owned Trello card link and the same configured attribution footer, and one reserved
status-marker pair. Publication wiring uses this renderer for newly created pull requests; configuring the `commit` model does not
allow it to choose headings, links, footer text, or status markers. Existing open pull
requests retain their identity; managed description/outcome sections are refreshed
after significant updates while preserving human text outside those sections.

`planning` and `planReview` use the same optional `model`/`variant` shape as other stages. The remaining configured consumers are `refinement`, `implementation`, `review`, `remediation`, and `commit`. These values are scoped to their project and activity.

The `remediation` stage also accepts the optional `maxPasses` setting:

| Key                   | Meaning and validation                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `maxPasses`           | Non-negative integer maximum number of implementation-review repair passes; defaults to `1` when omitted          |
| `validationMaxPasses` | Non-negative integer maximum number of local validation/coverage repair passes; defaults to `2` when omitted      |
| `ciMaxPasses`         | Non-negative safe integer maximum number of CI correction passes per repair episode; defaults to `2` when omitted |

The initial implementation review is not counted. A value of `0` runs the initial review with no
repair; `1` permits one repair followed by one final review; `2` permits two repairs
followed by a final review. If review still fails when the limit is reached, the
latest verified implementation proceeds to PR publication for **Human Review only**:
unresolved findings are recorded in the task execution state and disclosed in
the PR description, without sending an Attention Required notification.
Failed or unavailable local validation and coverage are disclosed in a draft PR,
not used as publication gates.
An unresolved review never changes human ownership of the pull request outcome. Automatic merging is not supported.
The attempt count and final reviewed snapshot are persisted outside the Git
worktree for crash-safe resumption.

Local validation/coverage repair has its own `validationMaxPasses` maximum and is
persisted per validation cycle. A completed repair attempt that makes no exact
source-content change ends the cycle without rerunning unchanged quality commands;
the primary session may also explicitly finish early when no further repair is
useful. Failing quality results remain advisory and are retained for accurate draft
publication.

CI correction has a separate `ciMaxPasses` maximum (`0` observes without correcting).
The episode limit and charges are durable: polling, restart, reruns, the agent's
commits and routine target merges do not renew it. A verified new actionable human
request, including a request to retry, can establish a fresh episode; incidental
edits and unchanged exhausted requests cannot. Exhaustion returns to Human Review
with the existing PR and failure diagnostics retained, not task failure. Changing
configuration on restart does not change an already established episode's limit.

## Validation rules

In addition to the field rules above, startup rejects duplicate project IDs, GitHub repositories, repository paths,
worktree roots, and Trello board IDs. It also rejects any normalized overlap between a project's repository path and
worktree root, including equivalent paths written with `.` or `..`. The YAML object structure is strict, so unsupported
top-level, project, repository, OpenCode, Trello, notification, SMTP, or event keys are rejected.

Startup also verifies the configured repositories and Trello resources. An existing repository path must be a valid Git
repository; a missing path may be cloned from the configured GitHub repository with `gh`. Projects without `githubApp` must
already have ambient GitHub authentication available. Projects with `githubApp` use the configured App during cloning and
every later GitHub operation. Trello lists and labels are checked on their configured boards before polling
starts. A transient Trello failure during that check is deferred to the project worker, which retries it on later polling
cycles before processing cards. Context directories are created only by the context-storage helpers, not as an implicit side
effect of loading configuration or starting the service.
