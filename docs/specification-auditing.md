# Specification compliance and auditing

`requirements.md` is authoritative; `specification.md` is the verifiable specification. Shared
procedures live only in `.agents/skills/spec-compliance/SKILL.md` and
`.agents/skills/spec-audit/SKILL.md`. Adapters link to these files rather than fork their
procedures.

## Invocation

Ask an assistant to load `spec-compliance` before specification-governed coding or review. For an
audit, load `spec-audit` and specify one of:

- `Full audit of HEAD; retain results in .local/spec-audits/<audit-id>/`.
- `Scoped audit of REQ-REC and REQ-WF (including affected dependencies)`.
- `Changes audit of git diff <base>...<head>; include affected recovery paths`.

OpenCode: select `spec-auditor` or invoke `@spec-auditor` with the audit request. Codex: invoke
`$spec-audit`. Claude Code: invoke `/spec-audit`. Copilot: request the shared skill by name; skill
availability depends on the client/version. If skill discovery is unavailable, read the canonical
`SKILL.md` directly. Restart OpenCode after installing these repository instructions.

## Local evidence and recovery

Use a unique directory beneath `.local/spec-audits/` (ignored by Git). Retain reports there after
completion; do not rely on temporary transcripts. Each audit contains:

| Artifact                | Contents                                                        |
| ----------------------- | --------------------------------------------------------------- |
| `inventory.json`        | Document hashes, every ID/criterion and source statement        |
| `requirements-map.json` | Every source statement mapped to criteria or a documented gap   |
| `matrix.json`           | One assessment per in-scope criterion with concrete evidence    |
| `findings.md`           | Prioritized findings with expected/observed evidence and action |
| `progress.md`           | Revision, scope, batches, completed/pending keys, resume notes  |
| `summary.md`            | Counts, conclusions, uncertainties, checks, artifact paths      |
| `evidence/`             | Retained command results and domain-level production traces     |

From the repository root, `node scripts/spec-audit.mjs inventory` emits the complete current
inventory. `node scripts/spec-audit.mjs check <directory>/matrix.json` rejects missing, duplicate,
unknown, invalidly classified, or structurally incomplete rows for a full audit. For a scoped audit,
retain the full inventory and explicit exclusions; review the selected set separately. The checker
does not judge source evidence, require a passing classification, or replace independent review.

To resume: ask
`Load spec-audit and resume <directory>; verify recorded inputs before continuing pending batches`.
Never infer completion from a report file's existence. Check input hashes and working-tree changes,
preserve older evidence, and invalidate affected assessments if inputs changed. Do not mark an audit
complete until every selected criterion and authoritative source statement has an assessment and the
independent completeness review is recorded. Unverified is an assessment, not proof of compliance.
Audits never authorize implementing their findings.

## Assistant compatibility

- OpenCode discovers project `.agents/skills` and `.opencode/agents`; its dedicated agent permits
  report edits only. Shell execution remains an instruction boundary: inspect commands and restrict
  effects to reports or disposable test fixtures. Permissions are defense in depth, not an OS
  sandbox.
- Codex discovers `AGENTS.md` and `.agents/skills` natively.
- Copilot uses `.github/copilot-instructions.md`; current supported surfaces also discover
  `.agents/skills`. The instruction file provides canonical paths for other versions.
- Claude Code imports `AGENTS.md` from minimal `CLAUDE.md`; `.claude/skills` contains directory
  symlinks to the canonical shared skills. Checkouts must preserve symlinks.

Supported conventions were consulted at [OpenCode](https://opencode.ai/docs/skills/),
[Codex](https://developers.openai.com/codex/build-skills),
[Copilot](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills), and
[Claude Code](https://code.claude.com/docs/en/skills). Runtime verification is version-specific;
report the exact tools actually exercised and label unavailable integrations as statically
inspected.
