# Contributing

Thank you for contributing to Agent Orchestrator. Keep changes focused on the
orchestration service and preserve its safety boundaries and existing workflow
behavior.

## Development setup

Supported tooling is:

- Node.js 24 or later;
- Yarn Classic 1.x (the repository uses Yarn 1.22.22);
- Git;
- GitHub CLI (`gh`) when working with managed repositories; and
- OpenCode when running the orchestrator locally.

Install dependencies from the repository root:

```bash
yarn install
```

To run the service locally, create the ignored configuration files:

```bash
cp config.example.yaml config.yaml
cp .env.example .env
```

Add the Trello credentials to `.env`, configure the project and workflow IDs
in `config.yaml`, and authenticate the GitHub CLI for the repositories the
orchestrator manages. Do not commit `config.yaml`, `.env`, credentials, or
other secrets.

## Validation

Run the complete required validation suite before opening a pull request:

```bash
yarn validate
```

The individual checks are:

```bash
yarn lint
yarn format:check
yarn typecheck
yarn test
```

The production build is also checked by CI and can be run locally with:

```bash
yarn build
```

Use `yarn lint:fix` for automatic lint fixes and `yarn format` to format the
repository when needed.

## Testing

Tests use the repository's Vitest-based test suite. Run them with `yarn test`
or as part of `yarn validate`. Unit tests must remain deterministic and must
not require live Trello, GitHub, or OpenCode services.

## Commits

Use the concise commit format used in the repository's recent history:

```text
type(scope): summary
```

For example, `docs(readme): clarify setup`. Keep the summary short and use a
scope that identifies the affected area when one is useful.

## Pull requests

Pull requests should:

- describe the change and its motivation clearly;
- reference a related issue or Trello card when applicable;
- list the validation commands run and their results; and
- be focused, reviewable, and ready for review without unrelated changes.

The pull request template provides a short checklist for these expectations.
