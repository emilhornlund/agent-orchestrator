[![CI](https://github.com/emilhornlund/agent-orchestrator/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/emilhornlund/agent-orchestrator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-339933?logo=node.js&logoColor=white)](CONTRIBUTING.md#development-setup)

# Agent Orchestrator

Agent Orchestrator is a local automation service that turns Trello cards into reviewed GitHub pull requests using
OpenCode.

It coordinates Trello, Git worktrees, OpenCode, and GitHub into a controlled software-engineering workflow. Human approval
remains at the merge boundary by default; a project can explicitly opt into automatic implementation merges.

## How it works

Each configured project connects a local Git repository, a GitHub repository, a Trello board, and an OpenCode runtime.
The orchestrator polls each project independently and processes eligible cards:

```text
Ready for Agent -> Working -> Human Review -> Done
                         |          ^          |
                         |          |          +-> merged pull request
                         |          +----------+    requested changes
                         +-> auto-merge -> Done

Automated failure -> Failed
Refinement: Ready for Agent -> Working -> Backlog -> Ready for Agent
```

Cards with the `Refinement` label are refined before implementation. Other eligible cards need at least one implementation
classification label: `Feature`, `Improvement`, or `Bug`. The orchestrator creates pull requests and responds to review
feedback. Human approval is required unless the project's `autoMerge` setting is explicitly enabled. See the [workflow
reference](docs/workflow.md) for the complete lifecycle, lists, labels, and transitions.

## Documentation

| Topic                                                                | Reference                              |
| -------------------------------------------------------------------- | -------------------------------------- |
| Workflow lifecycle, Trello states, refinement, and review feedback   | [Workflow](docs/workflow.md)           |
| `config.yaml`, environment variables, defaults, and validation       | [Configuration](docs/configuration.md) |
| Reconciliation, restart recovery, retries, and ambiguous state       | [Recovery](docs/recovery.md)           |
| Worktree safety, publication, notifications, logging, and operations | [Operations](docs/operations.md)       |
| Development setup, testing, and pull requests                        | [CONTRIBUTING.md](CONTRIBUTING.md)     |
| Private vulnerability reporting                                      | [SECURITY.md](SECURITY.md)             |

The focused pages are the canonical references for their topics. The implementation does not change when documentation is
reorganized; current configuration names, states, commands, and safety boundaries are described there.

## Key properties

- Agent work runs in an isolated worktree and task branch; the configured source checkout is not used as the agent's
  working directory.
- Pull requests are never merged automatically unless the owning project explicitly enables `autoMerge`; task branches are
  never force-pushed.
- Only one task is active per project at a time. Independent projects can be processed concurrently.
- Failed or interrupted work is reconciled from deterministic Trello, Git, GitHub, and session-log artifacts rather than
  being silently discarded. See [Recovery](docs/recovery.md).

## Requirements

- Node.js 24 or later
- Yarn Classic 1.x
- Git
- GitHub CLI (`gh`) 2.40.0 or later; projects that omit `repository.githubApp` use an authenticated `gh` session or ambient
  GitHub authentication such as a PAT in `GH_TOKEN` or `GITHUB_TOKEN`, while App-backed projects use their configured
  installation token
- OpenCode
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

Add `TRELLO_API_KEY` and `TRELLO_TOKEN` to `.env`, then configure one or more projects in `config.yaml`. For a project without
`repository.githubApp`, optionally set `GH_TOKEN` or `GITHUB_TOKEN` for PAT-based ambient GitHub authentication, or use an
authenticated `gh` session. These variables are unnecessary for projects using a GitHub App. Email credentials are only needed
when email notifications are enabled. See the [configuration reference](docs/configuration.md) for every setting, default, and
validation rule.

## Running

Start the orchestrator with:

```bash
yarn dev
```

The process continues polling until it is stopped. Shutdown, fatal errors, notifications, logging, and other operator
guidance are covered in [Operations](docs/operations.md). If the process is interrupted, use [Recovery](docs/recovery.md)
before changing cards, branches, or worktrees.

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

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, individual checks, testing, commits, and pull requests.

## Continuous integration

GitHub Actions validates pull requests targeting `main` and pushes to `main` with formatting, linting, TypeScript type
checking, tests, and a production build.

Dependabot checks the npm and GitHub Actions ecosystems weekly, with up to five open update pull requests per ecosystem.
Routine version updates use a seven-day cooldown; security updates are not delayed.

## License

Agent Orchestrator is available under the [MIT License](LICENSE).
