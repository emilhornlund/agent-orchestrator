# Repository instructions

Read and follow [AGENTS.md](../AGENTS.md) for architecture, invariants, development, and validation.
`docs/requirements.md` is authoritative; `docs/specification.md` defines verifiable criteria.

For specification-governed coding or review, load
[spec-compliance](../.agents/skills/spec-compliance/SKILL.md) before changing behavior. For
requested full, scoped, or Git-diff audits, load [spec-audit](../.agents/skills/spec-audit/SKILL.md)
and follow [audit invocation and recovery guidance](../docs/specification-auditing.md). If the
client does not discover `.agents/skills` natively, read those canonical files directly. Audits are
read-only except retained reports in `.local/spec-audits/`; never implement findings or change
requirements/specifications to fit code during an audit.
