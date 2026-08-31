[![CI](https://github.com/emilhornlund/agent-orchestrator/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/emilhornlund/agent-orchestrator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-339933?logo=node.js&logoColor=white)](CONTRIBUTING.md#development-setup)

# Agent Orchestrator

Agent Orchestrator is a local automation service that turns Trello cards into reviewed GitHub pull requests using
OpenCode.

It coordinates Trello, Git worktrees, OpenCode, and GitHub into a controlled software-engineering workflow while keeping
human approval at the merge boundary.

## How it works

Each configured project connects:

- a local Git repository;
- a GitHub repository;
- a Trello board;
- an OpenCode model and runtime configuration.

The orchestrator continuously polls each project and routes cards in `Ready for Agent` according to their configured
workflow labels.

Cards carrying the configured `Refinement` label enter the refinement workflow. Refinement takes precedence even when
the card also carries a `Feature`, `Improvement`, or `Bug` label.

Cards without `Refinement` enter the implementation workflow when they carry at least one configured `Feature`,
`Improvement`, or `Bug` label:

```text
Ready for Agent + Refinement
      │
      ▼
    Working
      │
      ├─ create isolated Git worktree
      ├─ run OpenCode refinement
      ├─ validate the structured refinement result
      ├─ reject unauthorized repository changes
      ├─ update the Trello card title and description
      ├─ replace Refinement with exactly one of Feature / Improvement / Bug
      ├─ clean up the refinement worktree
      │
      ▼
    Backlog
```

Successful refinement returns the card to the top of `Backlog`. It must be explicitly moved back to `Ready for Agent`
before implementation begins.

The normal implementation workflow is:

```text
Ready for Agent
      │
      ▼
    Working
      │
      ├─ create isolated Git worktree
      ├─ run optional repository setup
      ├─ run OpenCode implementation
      ├─ agents run optional repository validation
      ├─ run independent OpenCode review
      ├─ remediate review findings when necessary
      └─ commit, push, and create pull request
      │
      ▼
 Human Review
      │
      ├─ merged ───────────────► Done
      │
      ├─ changes requested ────► Working
      │                          │
      │                          └─ remediate, review, and update PR
      │
      └─ closed without merge ─► Failed
```

Failures during automated processing move the card to `Failed` rather than silently advancing the workflow.

## Key properties

### Isolated execution

Agent work runs in dedicated Git worktrees and task branches. The configured source checkout is not used as the agent's
working directory.

Branches follow the convention:

```text
agent/<trello-card-id>
```

### Human-controlled merges

The orchestrator creates and updates pull requests, but it does not merge them.

A card reaches `Done` only after the corresponding pull request has been merged on GitHub.

### Independent implementation and review

Implementation, review, remediation, and commit creation use separate OpenCode sessions.

The review phase evaluates the completed change independently before the branch is published.

### Elapsed workflow time

When an implementation card is successfully published and moved to `Human Review`, its Trello success comment includes a
line such as:

```text
Elapsed workflow time: 1 hour 5 minutes
```

This is elapsed workflow time from the current automated pass to its successful `Human Review` transition, not OpenCode-only
runtime. For an initial pass, the timer starts at the qualifying `Ready for Agent` to `Working` transition. A deliberate retry
from `Failed` starts at its subsequent `Failed` to `Ready for Agent` transition. A pass responding to human review feedback
starts at its `Human Review` to `Working` transition. The timer ends at that pass's resulting `Working` to `Human Review`
transition.

The value is formatted with explicit units, using seconds, minutes, hours, and days as needed. If Trello action history is
missing, incomplete, malformed, ambiguous, or has invalid date ordering, the summary comment is still attempted and the card
remains in `Human Review`; the orchestrator logs why the elapsed workflow time was omitted.

### Optional email notifications

Email notifications are disabled when `notifications.email` is omitted or when its `enabled` value is `false`. To enable
them, add this top-level configuration:

```yaml
notifications:
  email:
    enabled: true
    recipients:
      - "reviewers@example.com"
    from: "agent-orchestrator@example.com"
    smtp:
      host: "smtp.example.com"
      port: 465
      secure: true
      usernameEnv: "SMTP_USERNAME"
      passwordEnv: "SMTP_PASSWORD"
      timeoutSeconds: 30
```

`recipients` and `from` are email addresses. `smtp.host`, `smtp.port`, and `smtp.secure` select the SMTP server connection;
`secure: true` uses implicit TLS. `usernameEnv` and `passwordEnv` are the names of environment variables containing the SMTP
credentials. The default `timeoutSeconds` is `30`, and each notification makes one bounded delivery attempt without
automatic retries.

Set the referenced credentials in the ignored `.env` file or another secure runtime environment. Never put SMTP passwords,
API keys, or tokens in `config.yaml` or source control. Enabled settings and referenced environment variables are validated
at startup with field-specific errors; omitted or disabled settings require no SMTP credentials.

The orchestrator sends one email after each successful orchestrator transition into `Human Review` from normal publication or
reconciliation, and after each successful orchestrator transition into `Failed` from automated failure handling or a closed,
unmerged pull request. It does not notify for cards merely observed in either list, unrelated list transitions, or repeated
polling of an already completed transition. Human Review messages include the project, card, Trello URL, pull-request URL,
commit/publication context, review result, and remediation result. Failed messages include the project, card, Trello URL,
failure category and reason, and the deliberate retry instruction.

Delivery is attempted only after the Trello move succeeds. A delivery failure is logged with project and card context and does
not move the card, change the primary workflow error, or prevent the existing Trello summary/failure handling.

### Pull request feedback loop

When GitHub reports requested changes, the orchestrator moves the Trello card back to `Working`, creates a worktree from
the existing task branch, supplies the review feedback to OpenCode, and republishes the updated branch.

### Recovery and reconciliation

The orchestrator reconciles Trello state with Git and GitHub on every polling cycle. This allows it to recover from
interrupted runs and handle already-existing branches or pull requests without blindly recreating workflow state.

When a card is moved from `Failed` back to `Ready for Agent`, the orchestrator reuses the card's existing worktree and
`agent/<trello-card-id>` branch when both are still valid. A clean branch with tracked changes relative to
`origin/<defaultBranch>` is treated as committed implementation work. The retry skips setup, implementation, review,
remediation, and commit, then resumes publication. It uses a normal non-force push when the remote branch is missing or
does not yet point at that commit, checks for an existing open pull request, and creates one only when needed.

An existing worktree or branch alone is not proof that implementation is complete. A branch at its base, a branch with no
tracked committed changes, or a dirty worktree follows the normal implementation path; uncommitted work is preserved for
OpenCode to inspect. If an open pull request already exists, the card is reconciled directly to `Human Review` without
rerunning implementation or creating a duplicate pull request. Publication or Trello failures leave the card in its
failure/reconciliation state instead of advancing it silently.

Workflow recovery uses only deterministic workflow artifacts. Before a newly claimed card is moved to `Working`, its
`<worktreeRoot>/<trello-card-id>` worktree is prepared on `agent/<trello-card-id>`. If the move fails, that worktree remains
available for the next attempt.

A `Working` card is recoverable only when Trello action history shows its latest transition into `Working` came from `Ready for
Agent` and the expected worktree exists on the expected branch, or when the transition came from `Human Review` and the
expected open pull request has actionable requested changes. Other manual moves into `Working` are corrected to `Backlog`,
including when stale branches or worktrees exist. Working reconciliation never creates worktrees.

`Human Review` cards are reconciled from the expected `agent/<trello-card-id>` pull request. Merged pull requests move cards to
`Done`, closed unmerged pull requests move them to `Failed`, open pull requests with requested changes return to `Working`,
open pull requests without requested changes remain in `Human Review`, and cards without an expected pull request return to
`Backlog`. To retry deliberately, move a card to `Ready for Agent`; `Backlog`, `Failed`, and `Done` are not automatically
processed.

### Multi-project operation

Multiple projects can be configured in a single `config.yaml`. Each project is polled independently with its own
repository, Trello board, worktree root, and OpenCode configuration.

## Requirements

- Node.js 24 or later
- Yarn Classic 1.x
- Git
- GitHub CLI (`gh`)
- OpenCode
- Trello API credentials
- An SMTP server, when email notifications are enabled

The GitHub CLI must already be authenticated for the repositories the orchestrator manages.

## Setup

Install dependencies:

```bash
yarn install
```

Create the local configuration files:

```bash
cp config.example.yaml config.yaml
cp .env.example .env
```

Add your Trello credentials to `.env`:

```dotenv
TRELLO_API_KEY=
TRELLO_TOKEN=
# Required only when notifications.email.enabled is true.
SMTP_USERNAME=
SMTP_PASSWORD=
```

Then configure one or more projects in `config.yaml`:

```yaml
projects:
  - id: "my-project"

    trello:
      boardId: "board-id"
      backlogListId: "backlog-list-id"
      readyListId: "ready-list-id"
      workingListId: "working-list-id"
      reviewListId: "review-list-id"
      failedListId: "failed-list-id"
      doneListId: "done-list-id"
      refinementLabelId: "refinement-label-id"
      featureLabelId: "feature-label-id"
      improvementLabelId: "improvement-label-id"
      bugLabelId: "bug-label-id"

    repository:
      path: "/absolute/path/to/repository"
      github: "owner/repository"
      defaultBranch: "main"
      worktreeRoot: "/absolute/path/to/worktrees/repository"
      setupCommand: "yarn install"
      validationCommand: "yarn validate"
      gitIdentity:
        name: "Agent Orchestrator"
        email: "agent-orchestrator@users.noreply.github.com"
        signingKey: "/absolute/path/to/signing-key"

    opencode:
      timeoutMinutes: 360
      refinement:
        model: "your-refinement-model"
        variant: "xhigh"
      implementation:
        model: "openai/implementation-model"
        variant: "xhigh"
      review:
        model: "openai/review-model"
        variant: "high"
      remediation:
        model: "openai/remediation-model"
        variant: "xhigh"
      commit:
        model: "openai/commit-model"
        variant: "low"

workflow:
  pollIntervalSeconds: 15
  logRetentionDays: 14

notifications:
  email:
    enabled: false
    recipients:
      - "reviewers@example.com"
    from: "agent-orchestrator@example.com"
    smtp:
      host: "smtp.example.com"
      port: 465
      secure: true
      usernameEnv: "SMTP_USERNAME"
      passwordEnv: "SMTP_PASSWORD"
      timeoutSeconds: 30
```

`setupCommand` and `validationCommand` are optional. When configured, `setupCommand` runs in the card worktree before
the OpenCode implementation session. `validationCommand` is passed to OpenCode sessions that modify implementation
files, and those agents run it before finishing and fix failures caused by their changes. The orchestrator does not
execute the validation command itself.

`logRetentionDays` defaults to `14` when omitted. It controls retention for daily orchestrator logs, including test-prefixed
daily logs, and per-card session logs under `logs/sessions`. Files are removed when their filesystem modification time is
strictly older than the retention cutoff. Cleanup runs at startup and once per day while the orchestrator is running. Missing
log directories are ignored, unrelated entries and symbolic links are preserved, and cleanup failures are logged without
stopping task processing. Failed-card session logs remain available until this policy removes them; session logs for cards
successfully moved to `Done` are still removed immediately.

`config.yaml` and `.env` are local files and are intentionally excluded from version control.

## Trello board

Each project requires six configured workflow lists:

| List              | Purpose                                                       |
| ----------------- | ------------------------------------------------------------- |
| `Backlog`         | Tasks that are not currently queued for automated processing  |
| `Ready for Agent` | Tasks waiting to be claimed                                   |
| `Working`         | Tasks currently under automated implementation or remediation |
| `Human Review`    | Tasks with a published pull request awaiting human review     |
| `Failed`          | Tasks that could not complete the automated workflow          |
| `Done`            | Tasks whose pull requests have been merged                    |

Each project also requires four configured workflow labels:

| Label         | Purpose                                                |
| ------------- | ------------------------------------------------------ |
| `Refinement`  | Marks a task for refinement rather than implementation |
| `Feature`     | Classifies the card as feature implementation work     |
| `Improvement` | Classifies the card as improvement implementation work |
| `Bug`         | Classifies the card as bug-fix implementation work     |

The configured list and label names themselves are not significant; the orchestrator uses their Trello IDs.

For normal implementation, a card in `Ready for Agent` must have at least one of the configured `Feature`,
`Improvement`, or `Bug` labels. Unlabelled cards are ignored.

The configured `Refinement` label takes precedence over implementation labels. A card carrying `Refinement` is routed
through the refinement workflow even if it also carries `Feature`, `Improvement`, or `Bug`.

During refinement, OpenCode may inspect repository code, tests, documentation, and architecture, but it must not modify
repository implementation files. Its only permitted write is the dedicated structured refinement result artifact.

The orchestrator validates that result, updates the Trello card title and description, removes conflicting semantic
classification labels, applies exactly one of `Feature`, `Improvement`, or `Bug`, removes `Refinement`, and moves the
card to the top of `Backlog`.

If refinement fails, produces an invalid result, or modifies unauthorized repository files, the card moves to `Failed`.

## Running

Start the orchestrator:

```bash
yarn dev
```

The process continues polling until it is stopped.

### Shutdown and fatal runtime errors

`SIGINT` and `SIGTERM` request an idempotent coordinated shutdown. The service stops claiming new cards, cancels in-flight
subprocess and API work through the existing abort signal, and exits successfully after workers stop. An intentional signal
shutdown is not reported as a task failure.

Startup failures, uncaught exceptions, and unhandled promise rejections are logged as fatal diagnostics with the original
error details and a UTC timestamp. Their first fatal event requests the same coordinated shutdown and the process exits with
status `1`. Repeated fatal events or signals do not start duplicate cleanup or replace the original fatal diagnostic.

Shutdown does not mark cards successful, advance workflow state, delete recoverable worktrees, or discard agent changes. A
normal failure in one project remains isolated to that project and follows the existing card failure handling.

Restart recovery depends on the existing deterministic artifacts: Trello list-transition history, the expected
`agent/<trello-card-id>` branch and worktree, Git status and commits, pull requests, and per-card session logs. After a fatal
exit, inspect those artifacts and restart the service to run the existing reconciliation flow; do not assume that an
interrupted card should be marked successful or failed manually without reviewing its state.

## Logging

Lifecycle events, warnings, and errors emitted by the shared `Logger` begin with a UTC ISO 8601 timestamp, such as
`2026-08-30T09:00:00.000Z`. The timestamp is followed by the existing project and card context, when present, and the
message. Multiline logger messages receive the same prefix on every physical console line. Daily orchestrator log files
keep their existing `timestamp level context message` format, including the `test-` filename prefix used by tests.

Raw command and OpenCode output is written to per-card session logs or forwarded directly to process standard streams;
it is not timestamped by the shared `Logger`.

## Development

Run the complete validation suite:

```bash
yarn validate
```

Individual commands are also available:

```bash
yarn lint
yarn typecheck
yarn test
yarn format:check
```

Apply automatic lint fixes:

```bash
yarn lint:fix
```

Format the repository:

```bash
yarn format
```

## Continuous integration

GitHub Actions validates every pull request targeting `main` and every push to `main`.

CI verifies:

- formatting;
- linting;
- TypeScript type checking;
- tests;
- production build.

Run the primary validation suite locally with:

```bash
yarn validate
yarn format:check
yarn build
```

## Dependabot updates

Dependabot checks the npm and GitHub Actions ecosystems weekly from the repository root, with up to five open update
pull requests per ecosystem. Both update entries use an explicit `cooldown.default-days: 7` policy: routine version
updates wait seven days after release before Dependabot can propose them during a later scheduled check. This observation
window reduces supply-chain risk from newly published releases that may be compromised or otherwise unsafe.

The cooldown applies only to routine version updates. Dependabot security updates are not delayed by this setting and can
be proposed promptly when a vulnerability is identified.

## Configuration reference

### `projects[].id`

Non-empty identifier used to distinguish projects in configuration and logs. Project IDs must be unique.

### `projects[].trello`

Trello board, workflow list, and workflow label IDs for the project.

The configured fields are:

- `boardId` — Trello board containing the workflow.
- `backlogListId` — Backlog list.
- `readyListId` — list from which eligible implementation cards are claimed.
- `workingListId` — list used while automated work is in progress.
- `reviewListId` — list used while a published pull request awaits human review.
- `failedListId` — list used for failed automated work.
- `doneListId` — list used after the associated pull request is merged.
- `refinementLabelId` — label that routes a Ready card through automated refinement instead of normal implementation.
- `featureLabelId` — Feature implementation classification.
- `improvementLabelId` — Improvement implementation classification.
- `bugLabelId` — Bug implementation classification.

All configured workflow list IDs must be unique. All configured workflow label IDs must also be unique.

At startup, the orchestrator verifies that every configured workflow list exists and is open on the configured board and that
every configured workflow label exists on that board.

Each configured project must use a different Trello board.

### `projects[].repository.path`

Absolute path to the normal local checkout of the repository. Repository paths must be unique across configured
projects.

### `projects[].repository.github`

GitHub repository in `owner/repository` format. GitHub repositories must be unique across configured projects.

### `projects[].repository.defaultBranch`

Base branch used for task branches and pull requests.

### `projects[].repository.worktreeRoot`

Absolute directory under which isolated agent worktrees are created. Worktree roots must be unique across configured
projects.

### `projects[].repository.setupCommand`

Optional command executed in the card worktree before the OpenCode implementation session.

### `projects[].repository.validationCommand`

Optional repository validation command supplied to OpenCode sessions that modify implementation files. Those agents run
the command before finishing and address failures caused by their changes. The orchestrator does not execute the command
itself.

### `projects[].repository.gitIdentity`

Git identity used when the orchestrator creates commits for the project.

`gitIdentity` is required and contains:

- `name` — non-empty Git commit author and committer name.
- `email` — valid Git commit author and committer email address.
- `signingKey` — optional absolute path to the SSH signing key used for signed commits.

When `signingKey` is configured, the key must be available at that path in the environment where the orchestrator runs.

### `projects[].opencode.refinement`

Model and variant used for task refinement sessions.

### `projects[].opencode.implementation`

Model and variant used for task implementation and human review feedback implementation.

### `projects[].opencode.review`

Model and variant used for fresh code review passes.

### `projects[].opencode.remediation`

Model and variant used to address failed review findings.

### `projects[].opencode.commit`

Model and variant used for the final commit session.

### `projects[].opencode.timeoutMinutes`

Maximum runtime in minutes for an individual OpenCode execution across all workflow stages. Must be positive and
defaults to `360` when omitted.

### `notifications.email`

Optional global email notification settings shared by all projects. Omit this section, or set `enabled: false`, to disable
delivery without requiring SMTP configuration.

When `enabled: true`, the following fields are required:

- `recipients` — one or more recipient email addresses.
- `from` — sender email address.
- `smtp.host` — SMTP server hostname.
- `smtp.port` — SMTP server port from `1` through `65535`.
- `smtp.secure` — whether to use implicit TLS for the connection.
- `smtp.usernameEnv` — environment-variable name containing the SMTP username.
- `smtp.passwordEnv` — environment-variable name containing the SMTP password.
- `smtp.timeoutSeconds` — positive connection and delivery timeout, defaulting to `30`.

The values of `smtp.usernameEnv` and `smtp.passwordEnv` are names, not credentials. Their values are validated at startup only
when email notifications are enabled. Notification email bodies never include those credentials.

### `workflow.pollIntervalSeconds`

Interval in seconds between project polling cycles. Must be a positive integer.

### `workflow.logRetentionDays`

Number of days to retain log files. Must be a positive whole number and defaults to `14` when omitted. This applies to
`logs/orchestrator-YYYY-MM-DD.log`, test-prefixed daily logs, and per-card session logs under `logs/sessions`. A file is
eligible for removal only when its filesystem modification time is strictly older than the cutoff; files at the cutoff and
newer are retained. Cleanup runs once at startup and once per day during continued operation. Missing log directories are a
no-op, unrelated files and directories and symbolic links are preserved, and failures to scan or remove an individual file
are logged with its path and the failure reason while other candidates continue to be processed.

## Safety boundaries

Agent Orchestrator deliberately keeps several operations outside automated control.

It does not:

    - merge pull requests;
    - force-push task branches;
    - run agent implementation directly in the source checkout;
    - resume a `Working` card unless its latest recorded transition and expected worktree, branch, or pull-request evidence make it recoverable;
    - process an active `Human Review` card without actionable requested changes on its expected pull request;
    - treat failed external operations as successful workflow transitions;

- silently discard failed agent work;
- delete arbitrary or unrecognized worktrees.

The orchestrator owns workflow coordination. OpenCode owns software-engineering execution. Humans retain final approval
through GitHub review and merge.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, validation,
testing, commit, and pull request guidance.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md),
not through public issues.

## License

Agent Orchestrator is available under the [MIT License](LICENSE).
