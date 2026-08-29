[![CI](https://github.com/emilhornlund/agent-orchestrator/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/emilhornlund/agent-orchestrator/actions/workflows/ci.yml)

# Agent Orchestrator

Agent Orchestrator is a local automation service that turns Trello cards into reviewed GitHub pull requests using OpenCode.

It coordinates Trello, Git worktrees, OpenCode, and GitHub into a controlled software-engineering workflow while keeping human approval at the merge boundary.

## How it works

Each configured project connects:

- a local Git repository;
- a GitHub repository;
- a Trello board;
- an OpenCode model and runtime configuration.

The orchestrator continuously polls each project and drives cards through the workflow:

```text
Ready for Agent
      │
      ▼
    Working
      │
      ├─ create isolated Git worktree
      ├─ run optional repository setup
      ├─ run OpenCode implementation
      ├─ run optional repository validation
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

Agent work runs in dedicated Git worktrees and task branches. The configured source checkout is not used as the agent's working directory.

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

### Pull request feedback loop

When GitHub reports requested changes, the orchestrator moves the Trello card back to `Working`, creates a worktree from the existing task branch, supplies the review feedback to OpenCode, and republishes the updated branch.

### Recovery and reconciliation

The orchestrator reconciles Trello state with Git and GitHub on every polling cycle. This allows it to recover from interrupted runs and handle already-existing branches or pull requests without blindly recreating workflow state.

### Multi-project operation

Multiple projects can be configured in a single `config.yaml`. Each project is polled independently with its own repository, Trello board, worktree root, and OpenCode configuration.

## Requirements

- Node.js 24 or later
- Yarn Classic 1.x
- Git
- GitHub CLI (`gh`)
- OpenCode
- Trello API credentials

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
```

Then configure one or more projects in `config.yaml`:

```yaml
projects:
  - id: "my-project"

    trello:
      boardId: "board-id"
      readyListId: "ready-list-id"
      workingListId: "working-list-id"
      reviewListId: "review-list-id"
      failedListId: "failed-list-id"
      doneListId: "done-list-id"

    repository:
      path: "/absolute/path/to/repository"
      github: "owner/repository"
      defaultBranch: "main"
      worktreeRoot: "/absolute/path/to/worktrees/repository"
      setupCommand: "yarn install"
      validationCommand: "yarn validate"

    opencode:
      timeoutMinutes: 360
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
```

`setupCommand` and `validationCommand` are optional. When configured, `setupCommand` runs in the card worktree before the OpenCode implementation session. `validationCommand` runs after implementation. OpenCode is still expected to follow the target repository's normal validation instructions during implementation.

`config.yaml` and `.env` are local files and are intentionally excluded from version control.

## Trello board

Each project requires five configured lists:

| List              | Purpose                                                       |
| ----------------- | ------------------------------------------------------------- |
| `Ready for Agent` | Tasks waiting to be claimed                                   |
| `Working`         | Tasks currently under automated implementation or remediation |
| `Human Review`    | Tasks with a published pull request awaiting human review     |
| `Failed`          | Tasks that could not complete the automated workflow          |
| `Done`            | Tasks whose pull requests have been merged                    |

The configured list names themselves are not significant; the orchestrator uses their Trello list IDs.

## Running

Start the orchestrator:

```bash
yarn dev
```

The process continues polling until it is stopped.

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

## Configuration reference

### `projects[].id`

Unique identifier used to distinguish projects in configuration and logs.

### `projects[].trello`

Trello board and workflow list IDs for the project.

### `projects[].repository.path`

Absolute path to the normal local checkout of the repository.

### `projects[].repository.github`

GitHub repository in `owner/repository` format.

### `projects[].repository.defaultBranch`

Base branch used for task branches and pull requests.

### `projects[].repository.worktreeRoot`

Directory under which isolated agent worktrees are created.

### `projects[].repository.setupCommand`

Optional command executed in the card worktree before the OpenCode implementation session.

### `projects[].repository.validationCommand`

Optional command executed by the orchestrator after implementation.

### `projects[].opencode.implementation`

Model and variant used for task implementation and human review feedback implementation.

### `projects[].opencode.review`

Model and variant used for fresh code review passes.

### `projects[].opencode.remediation`

Model and variant used to address failed review findings.

### `projects[].opencode.commit`

Model and variant used for the final commit session.

### `projects[].opencode.timeoutMinutes`

Maximum runtime for an individual OpenCode execution across all workflow stages.

### `workflow.pollIntervalSeconds`

Interval between project polling cycles.

## Safety boundaries

Agent Orchestrator deliberately keeps several operations outside automated control.

It does not:

- merge pull requests;
- force-push task branches;
- run agent implementation directly in the source checkout;
- treat failed external operations as successful workflow transitions;
- silently discard failed agent work;
- delete arbitrary or unrecognized worktrees.

The orchestrator owns workflow coordination. OpenCode owns software-engineering execution. Humans retain final approval through GitHub review and merge.
