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

`.env` is ignored by the repository. Keep Trello credentials, SMTP credentials, API keys, access tokens, and other secrets
out of configuration files and source control.

## Top-level settings

### `projects`

`projects` is a non-empty list. Each item has `id`, `autoMerge`, `trello`, `repository`, and `opencode` settings. Project IDs
must be unique.

### `workflow`

`workflow` is required and contains:

| Key                   | Meaning and validation                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `pollIntervalSeconds` | Positive integer interval between project polling cycles                                 |
| `logRetentionDays`    | Positive integer number of days for managed log retention; defaults to `14` when omitted |

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

The initial automated review is not counted. Each remediation pass consists of one remediation session followed by one new
review. A value of `0` disables automatic remediation, but the initial review still runs and the normal commit and publication
flow continues even when that review reports findings. A positive limit stops the loop after the configured number of passes;
the normal commit, publication, Human Review, and enabled auto-merge boundaries remain unchanged. The counter exists only for
the current workflow execution and is not stored on the Trello card.

## Validation rules

In addition to the field rules above, startup rejects duplicate project IDs, GitHub repositories, repository paths,
worktree roots, and Trello board IDs. The YAML object structure is strict, so unsupported top-level, project, repository,
OpenCode, Trello, notification, SMTP, or event keys are rejected.

Startup also verifies the configured repositories and Trello resources. An existing repository path must be a valid Git
repository; a missing path may be cloned from the configured GitHub repository with `gh`. The GitHub CLI must already be
authenticated for managed repositories. Trello lists and labels are checked on their configured boards before polling
starts.
