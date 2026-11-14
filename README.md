[![CI](https://github.com/emilhornlund/agent-orchestrator/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/emilhornlund/agent-orchestrator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-339933?logo=node.js&logoColor=white)](CONTRIBUTING.md#development-setup)

# Agent Orchestrator

Agent Orchestrator is a local automation service that turns Trello cards into reviewed GitHub pull
requests using OpenCode.

It coordinates Trello, Git worktrees, OpenCode, and GitHub into a controlled software-engineering
workflow. Humans own pull-request outcomes: the orchestrator never merges a PR, and approval or
passing checks do not complete a task.

## How it works

Each configured project connects a local Git repository, a GitHub repository, a Trello board, and an
OpenCode runtime. The orchestrator polls each project independently and processes eligible cards:

```text
Ready for Agent -> Working -> Human Review (open PR)
                    ^                   |                 |
                    |                   |                 +-> human closes unmerged -> Backlog
                    |                   +-> human merges -> Done
                    +------- requested changes -----------+

Automated failure -> Failed
Refinement: Ready for Agent -> Working -> Backlog -> Ready for Agent
```

Cards with the `Refinement` label are refined before implementation. Other eligible cards need at
least one implementation classification label: `Feature`, `Improvement`, or `Bug`. The orchestrator
creates pull requests and responds to review feedback. An open PR remains active and occupies its
project's task slot until a human merges or closes it; approval alone is not terminal. Configuration
with `autoMerge: true` is rejected. See the [workflow reference](docs/workflow.md) for the complete
lifecycle, lists, labels, and transitions. Pull request descriptions may be generated automatically
from the final implementation result.

Every project uses the restart-safe task-session workflow. One primary OpenCode session is retained
across implementation, bounded local/CI repairs, and human-feedback rounds; independent review
sessions verify the plan and implementation. The orchestrator runs configured validation and
coverage commands, records absent commands as skipped, and discovers current-head checks from
available GitHub repository rules and static repository workflow contracts. An unknown or incomplete
expected-check set waits or fails closed; visible green checks alone are never treated as proof that
all expected checks have started. See the [configuration](docs/configuration.md),
[workflow](docs/workflow.md), and [recovery](docs/recovery.md) references for operation and safe
recovery. Local mocked tests cover the workflow. A live task reached Human Review and reconciled CI
on 2026-11-14 with operator-assisted startup recovery; the recovery reference records qualification
limits and the separately tested automatic interrupted-creation recovery cases.

## Documentation

| Topic                                                                | Reference                                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Workflow lifecycle, Trello states, refinement, and review feedback   | [Workflow](docs/workflow.md)                                                    |
| `config.yaml`, environment variables, defaults, and validation       | [Configuration](docs/configuration.md)                                          |
| Reconciliation, restart recovery, retries, and ambiguous state       | [Recovery](docs/recovery.md)                                                    |
| Worktree safety, publication, notifications, logging, and operations | [Operations](docs/operations.md)                                                |
| Agreed product behavior and stable acceptance criteria               | [Requirements](docs/requirements.md) and [Specification](docs/specification.md) |
| Development setup, testing, and pull requests                        | [CONTRIBUTING.md](CONTRIBUTING.md)                                              |
| Private vulnerability reporting                                      | [SECURITY.md](SECURITY.md)                                                      |

Workflow, Configuration, Recovery, and Operations describe the current implementation. Requirements
defines agreed product behavior, and Specification provides stable acceptance IDs; neither is a
claim that every criterion has been qualified against live services. Contributor guidance explains
how to verify changes and report those limits.

## Key properties

- Agent work runs in an isolated worktree and task branch; the configured source checkout is not
  used as the agent's working directory.
- Pull requests are never merged automatically. Open PRs, including approved or draft PRs, block the
  project's next task until a human merges or closes them; `autoMerge: true` is rejected. Task
  branches are never force-pushed.
- Only one task is active per project at a time. Independent projects can be processed concurrently.
- Failed or interrupted work is reconciled from durable task records, queue ownership, Trello, Git,
  GitHub, and session evidence rather than being silently discarded. See
  [Recovery](docs/recovery.md).

## Requirements

- Node.js 24 or later
- Yarn Classic 1.x
- Git
- GitHub CLI (`gh`) 2.40.0 or later; projects that omit `repository.githubApp` use an authenticated
  `gh` session or ambient GitHub authentication such as a PAT in `GH_TOKEN` or `GITHUB_TOKEN`, while
  App-backed projects use their configured installation token
- OpenCode
- Linux with Bubblewrap (`bwrap`) and permission to create user/mount/PID namespaces, including
  inside container deployments. Writable agent dispatches fail closed when isolation is unavailable.
  Only the owned worktree content and OpenCode's dedicated session/cache directories are writable;
  Git metadata is read-only and the orchestrator owns commits. Install execution tools in standard
  system directories or explicit absolute `PATH` directories, and keep OpenCode configuration/auth
  in its dedicated directories rather than requiring access to the whole home directory.
- Trello API credentials
- An SMTP server when email notifications are enabled

## Setup

Install dependencies from the repository root:

```bash
yarn install
```

Create the ignored local configuration files:

```bash
cp config.example.yaml config.yaml
cp .env.example .env
```

Add `TRELLO_API_KEY` and `TRELLO_TOKEN` to `.env`, then configure one or more projects in
`config.yaml`. For a project without `repository.githubApp`, optionally set `GH_TOKEN` or
`GITHUB_TOKEN` for PAT-based ambient GitHub authentication, or use an authenticated `gh` session.
These variables are unnecessary for projects using a GitHub App. Email credentials are only needed
when email notifications are enabled. See the [configuration reference](docs/configuration.md) for
every setting, default, and validation rule.

## Running

Check your local configuration and executable compatibility before starting:

```bash
yarn doctor
```

Syntax: `yarn doctor [--json] [--config PATH | --config=PATH]`. Omit `--config` to check
`config.yaml`, or select a named file without copying it or changing directories. Relative paths
resolve against the invocation working directory; absolute paths are also supported. Quote paths
containing spaces. `--config PATH` and `--config=PATH` are equivalent and may appear before or after
`--json`.

```bash
yarn doctor --config configs/local.yaml
yarn doctor --config "/opt/agent/config files/production.yaml"
yarn doctor --json --config configs/local.yaml
yarn doctor --config "configs/local settings.yaml" --json
yarn doctor --config=configs/local.yaml
yarn doctor --json --config="configs/local settings.yaml"
yarn doctor --config="configs/local settings.yaml" --json
```

This read-only command reports passed, failed, or skipped checks for the selected configuration
file, Git, GitHub CLI, and OpenCode. Required failures include remediation guidance and produce a
nonzero exit status. It does not start workers or write repository/runtime state. Successful local
checks do not establish external integration operation or complete runtime readiness:
authentication, remote resources, isolation namespaces, coordination provisioning, and runtime
permissions remain unverified and are reported as skipped.

For machine-readable results, use `yarn doctor --json`. The doctor program emits exactly one JSON
document to stdout, with no text headings. Yarn itself may add wrapper output; use
`yarn --silent doctor --json` when capturing stdout for a JSON parser. For a selected file, use
`yarn --silent doctor --json --config "configs/local settings.yaml"`.

For example, text output for a valid selected file starts its configuration result with
`PASSED Configuration: "configs/local.yaml" exists and is valid.` The corresponding JSON check is
`{"id":"configuration","status":"passed","summary":"\"configs/local.yaml\" exists and is valid."}`
within the same version-1 report described below. A missing selected file reports that path and
suggests copying `config.example.yaml` there and configuring it. Malformed YAML, invalid settings
and unreadable files instead receive syntax, settings or file-access guidance, respectively, and a
nonzero exit status. Doctor does not fall back to `config.yaml` when a selected file fails.

The version-1 contract is:

- `schemaVersion`: the integer `1`, identifying this report schema.
- `requiredLocalChecksPassed`: a boolean covering configuration and local executable compatibility
  only. Exit status is `0` when true and nonzero when false.
- `runtimeReadiness`: always `"not-verified"`; local success does not certify runtime readiness.
- `checks`: an ordered array with stable `id`, `status` (`"passed"`, `"failed"`, or `"skipped"`),
  and a sanitized actionable `summary`. Summary wording is human guidance, not a parsing interface.
  IDs are `configuration`, `git`, `github-cli`, `opencode`, `external-integrations`, and
  `runtime-prerequisites`, in that order. The last two are always skipped and do not affect the
  required-local-check outcome.

Example successful report:

```json
{
  "schemaVersion": 1,
  "requiredLocalChecksPassed": true,
  "runtimeReadiness": "not-verified",
  "checks": [
    {
      "id": "configuration",
      "status": "passed",
      "summary": "config.yaml exists and is valid."
    },
    {
      "id": "git",
      "status": "passed",
      "summary": "installed version and required executable capabilities are compatible."
    },
    {
      "id": "github-cli",
      "status": "passed",
      "summary": "installed version and required executable capabilities are compatible."
    },
    {
      "id": "opencode",
      "status": "passed",
      "summary": "installed version and required executable capabilities are compatible."
    },
    {
      "id": "external-integrations",
      "status": "skipped",
      "summary": "authentication, permissions, connectivity, and service operation are not checked."
    },
    {
      "id": "runtime-prerequisites",
      "status": "skipped",
      "summary": "isolation namespaces, coordination provisioning, runtime filesystem permissions, and credential configuration are not checked."
    }
  ]
}
```

Unsupported arguments, duplicate options (including mixed `--config PATH` and `--config=PATH`
spellings), and missing, empty or whitespace-only `--config` values produce
`Usage: yarn doctor [--json] [--config PATH | --config=PATH]` and a nonzero exit status before
configuration loading or executable probes. Usage errors are text rather than diagnostic JSON
reports. Both formats omit configuration values, parser excerpts, and raw executable output.

First provision the required shared coordination namespace using the
[configuration instructions](docs/configuration.md#provisioning-a-shared-host-coordination-namespace).
Start the orchestrator with:

```bash
yarn dev
```

The process continues polling until it is stopped. Shutdown, fatal errors, notifications, logging,
and other operator guidance are covered in [Operations](docs/operations.md). If the process is
interrupted, use [Recovery](docs/recovery.md) before changing cards, branches, or worktrees. For
compiled local execution and the supplied non-root container image, see
[local and container installation](docs/operations.md#local-and-container-installation).

## Development

Run the complete validation suite:

```bash
yarn validate
```

The production build and formatting check can be run with:

```bash
yarn build
yarn format:check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, individual checks, testing, commits,
and pull requests.

## Continuous integration

GitHub Actions validates pull requests targeting `main` and pushes to `main` with formatting,
linting, TypeScript type checking, tests, and a production build.

Dependabot checks the npm and GitHub Actions ecosystems weekly, with up to five open update pull
requests per ecosystem. Routine version updates use a seven-day cooldown; security updates are not
delayed.

## License

Agent Orchestrator is available under the [MIT License](LICENSE).
