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

### Pull request feedback loop

When GitHub reports requested changes, the orchestrator moves the Trello card back to `Working`, creates a worktree from
the existing task branch, supplies the review feedback to OpenCode, and republishes the updated branch.

### Recovery and reconciliation

The orchestrator reconciles Trello state with Git and GitHub on every polling cycle. This allows it to recover from
interrupted runs and handle already-existing branches or pull requests without blindly recreating workflow state.

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
```

`setupCommand` and `validationCommand` are optional. When configured, `setupCommand` runs in the card worktree before
the OpenCode implementation session. `validationCommand` is passed to OpenCode sessions that modify implementation
files, and those agents run it before finishing and fix failures caused by their changes. The orchestrator does not
execute the validation command itself.

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

At startup, the orchestrator verifies that every configured workflow list exists and is open on the configured board,
and that every configured workflow label exists on that board.

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

### `workflow.pollIntervalSeconds`

Interval in seconds between project polling cycles. Must be a positive integer.

## Safety boundaries

Agent Orchestrator deliberately keeps several operations outside automated control.

It does not:

- merge pull requests;
- force-push task branches;
- run agent implementation directly in the source checkout;
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
