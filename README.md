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
optional orchestrator validation
        ↓
fresh OpenCode review
        ↓
optional single remediation pass
        ↓
OpenCode commit
        ↓
push task branch
        ↓
create pull request
        ↓
Trello: Human Review
        ↓
human merges pull request
        ↓
Trello: Done
```

OpenCode is expected to run the repository's normal build, test, lint, and
validation procedures as part of implementation and remediation.

Projects may additionally configure `repository.validationCommand` when an
independent orchestrator-side validation step is useful. This is optional.

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

The current implementation can:

1. read and claim the next eligible Trello card;
2. create a dedicated Git branch and isolated worktree;
3. run OpenCode in that worktree;
4. detect repository changes produced by OpenCode;
5. optionally run a configured repository validation command;
6. stage and create a local task commit.

The local commit implementation is temporary. The intended workflow will use
a fresh OpenCode review session before any commit is created. A single
remediation pass will be allowed when review finds problems, followed by
revalidation and another fresh review.

Commit creation will then be delegated to OpenCode so that the commit message
can be based on the final staged changes and the repository's commit-message
rules.

Push, pull-request creation, Trello review transitions, merge observation, and
worktree cleanup are not implemented yet.
