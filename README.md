# Agent Orchestrator

Local orchestration service for dispatching software-engineering tasks from Trello to OpenCode in isolated Git worktrees.

## Purpose

The orchestrator coordinates workflow state and external tooling. It is intentionally deterministic.

OpenCode is responsible for implementing and reviewing software-engineering tasks. The orchestrator is responsible for:

- reading the Trello work queue;
- creating isolated Git worktrees;
- starting OpenCode sessions;
- tracking execution state;
- validating workflow transitions;
- publishing branches and pull requests;
- observing human review and merge state;
- cleaning up completed worktrees.

## Workflow

The intended workflow is:

```text
Trello: Ready for Agent
        ↓
create isolated worktree
        ↓
OpenCode implementation
        ↓
validation
        ↓
fresh OpenCode review
        ↓
optional single remediation pass
        ↓
create pull request
        ↓
Trello: Human Review
        ↓
human merges pull request
        ↓
Trello: Done
```

Only one task may be active at a time.

## Safety Invariants

The orchestrator must never:

- modify the configured source checkout;
- start work for a card outside `Ready for Agent`;
- run more than one task concurrently;
- merge a pull request;
- force-push;
- delete an unknown worktree;
- automatically discard agent changes after a failure;
- advance workflow state after a failed external operation;
- start another task while the current task is in an ambiguous state.

## Requirements

- Node.js
- Yarn Classic 1.x
- Git
- OpenCode
- GitHub CLI (`gh`)

Additional external credentials are required for Trello.

## Setup

Install dependencies:

```bash
yarn install
```

Copy the example configuration:

```bash
cp config.example.yaml config.yaml
cp .env.example .env
```

Fill in the local repository, Trello, and OpenCode configuration.

`config.yaml` and `.env` are intentionally ignored by Git.

## Development

Run the application:

```bash
yarn dev
```

Run validation:

```bash
yarn validate
```

Apply automatic lint and formatting fixes:

```bash
yarn lint:fix
```

Run tests:

```bash
yarn test
```

## Configuration

Non-secret configuration lives in `config.yaml`.

Secrets are supplied through environment variables.

See:

- `config.example.yaml`
- `.env.example`

## Project Status

The project is currently in initial bootstrap development.

The first vertical slice will:

1. read the next eligible Trello card;
2. create an isolated Git worktree;
3. run OpenCode in that worktree;
4. stop for manual inspection.

Commit, push, pull-request creation, automated review, persistence, and the monitoring UI will be added after that execution path is proven.
