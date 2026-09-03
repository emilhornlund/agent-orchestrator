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

`projects` is a non-empty list. Each item has `id`, `autoMerge`, `trello`, `repository`, and `opencode` settings. Project IDs
must be unique.

### `workflow`

`workflow` is required and contains:

| Key                       | Meaning and validation                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `pollIntervalSeconds`     | Positive integer interval between project polling cycles                                  |
| `logRetentionDays`        | Positive integer number of days for managed log retention; defaults to `14` when omitted  |
| `contextRetentionDays`    | Positive integer number of days for card context retention; defaults to `14` when omitted |
| `contextRoot`             | Optional absolute root for card context; defaults to `/opt/.agent-context`                |
| `maxAttachmentBytes`      | Optional positive safe integer per-upload limit in bytes; defaults to 50 MiB              |
| `maxTotalAttachmentBytes` | Optional positive safe integer aggregate new-download limit in bytes; defaults to 200 MiB |

`contextRoot` is normalized with `path.resolve` like the other configured absolute paths. A custom value must be non-blank
and absolute. The root must not equal, contain, or be contained by any configured `projects[].repository.path` or
`projects[].repository.worktreeRoot`, including after normalization. Unknown `workflow` keys are rejected.

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
metadata and locations only: file contents, excerpts, and other full attachment data are never included. Commit prompts
remain unchanged.

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

Non-blank identifier used to distinguish projects in configuration and logs. It must be unique.

### `projects[].autoMerge`

Boolean that defaults to `false`. When `true`, only that project's normal implementation workflow automatically merges its
published pull request and moves the card to `Done`; refinement remains unchanged. When omitted or `false`, the pull
request is published and the card enters `Human Review` for the existing human-merge workflow. The value must be a boolean.

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

| Key                 | Meaning and validation                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `path`              | Absolute path to the normal local checkout; repository paths must be unique across projects                                 |
| `github`            | GitHub repository in `owner/repository` format; repositories must be unique across projects                                 |
| `defaultBranch`     | Non-blank base branch for task branches and pull requests                                                                   |
| `worktreeRoot`      | Absolute directory for isolated task worktrees; roots must be unique across projects                                        |
| `setupCommand`      | Optional non-blank command run in the card worktree before implementation                                                   |
| `validationCommand` | Optional non-blank command supplied to OpenCode sessions that modify implementation files; the orchestrator does not run it |
| `gitIdentity`       | Required identity used by the commit session                                                                                |
| `githubApp`         | Optional GitHub App identity used for all authenticated GitHub operations for this project                                  |

`path`, `worktreeRoot`, and an optional `gitIdentity.signingKey` must be absolute paths. Parsed absolute paths are resolved
before use. `gitIdentity` contains:

| Key          | Meaning and validation                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| `name`       | Non-blank commit author and committer name                                                                 |
| `email`      | Valid commit author and committer email address                                                            |
| `signingKey` | Optional absolute path to the SSH signing key; it must be available where the service runs when configured |

If `setupCommand` is configured, it runs in the task worktree before the OpenCode implementation session. If
`validationCommand` is configured, it is passed to the relevant OpenCode prompts; those agents run it before finishing and
fix failures caused by their changes.

#### GitHub authentication modes

GitHub authentication is selected independently for each project at the `repository.githubApp` boundary. These are the two
supported modes:

- **GitHub App:** When `repository.githubApp` is configured, the project's authenticated GitHub operations use a short-lived
  installation token for that App installation.
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
access token. A successful token and its `expires_at` value are retained only in process memory for that App installation;
the token is reused until five minutes before expiration, then refreshed. Cache entries include the App ID, installation ID,
and private-key path, and are not shared across different App configurations or installations. The private key, JWT, token,
and expiration data are not logged, persisted, or included in configuration. The resolved token is supplied only through a
child-process environment for the bounded operation that needs it: `gh repo clone`, other
GitHub CLI pull-request and review operations, and `git fetch`, `git ls-remote`, `git push`, or remote-branch deletion. Git
temporarily clears configured credential helpers and obtains the token through `GIT_ASKPASS`; it is not placed in command
arguments or repository URLs. If an App is configured, that App mode takes precedence for the project. A missing or unreadable
private key, invalid App credentials, a JWT generation failure, or an installation-token exchange failure fails the affected
operation. None of these failures trigger a fallback to PAT or other ambient authentication. The App is configured at the
project boundary, so its credentials are not shared with another project.

When `githubApp` is omitted, the orchestrator leaves the GitHub CLI and Git environment unchanged. Ambient `GH_TOKEN` and
`GITHUB_TOKEN` values are recognized for output redaction only; they are not replaced or copied into a child environment.
`GH_TOKEN` is therefore optional and is needed only when an operator chooses PAT-based ambient authentication. It is not
required for projects using a GitHub App.

### `projects[].opencode`

Each stage requires a non-blank `model` and `variant`:

| Stage            | Used for                                                           |
| ---------------- | ------------------------------------------------------------------ |
| `refinement`     | Refining a Trello task and classifying it                          |
| `implementation` | Initial implementation and implementation of human review feedback |
| `review`         | Independent review pass                                            |
| `remediation`    | Addressing review findings; includes the automatic pass limit      |
| `commit`         | Final commit session                                               |

`projects[].opencode.timeoutMinutes` is the positive maximum runtime in minutes for an individual OpenCode execution at any
stage. It defaults to `360` when omitted.

The `remediation` stage also accepts the optional `maxPasses` setting:

| Key         | Meaning and validation                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------- |
| `maxPasses` | Non-negative integer maximum number of automatic remediation passes; defaults to `1` when omitted |

The initial automated review is not counted. Each remediation pass consists of one remediation session; a new review runs
after it only when another remediation pass remains. Therefore, a value of `1` runs the initial review and one remediation with
no final follow-up review, while a value of `2` permits one review between two remediation sessions. A value of `0` disables
automatic remediation, but the initial review still runs and the normal commit and publication flow continues even when that
review reports findings. The normal commit, publication, Human Review, and enabled auto-merge boundaries remain unchanged.
The counter exists only for the current workflow execution and is not stored on the Trello card.

## Validation rules

In addition to the field rules above, startup rejects duplicate project IDs, GitHub repositories, repository paths,
worktree roots, and Trello board IDs. The YAML object structure is strict, so unsupported top-level, project, repository,
OpenCode, Trello, notification, SMTP, or event keys are rejected.

Startup also verifies the configured repositories and Trello resources. An existing repository path must be a valid Git
repository; a missing path may be cloned from the configured GitHub repository with `gh`. Projects without `githubApp` must
already have ambient GitHub authentication available. Projects with `githubApp` use the configured App during cloning and
every later GitHub operation. Trello lists and labels are checked on their configured boards before polling
starts. A transient Trello failure during that check is deferred to the project worker, which retries it on later polling
cycles before processing cards. Context directories are created only by the context-storage helpers, not as an implicit side
effect of loading configuration or starting the service.
