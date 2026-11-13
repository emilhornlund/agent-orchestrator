---
name: spec-compliance
description:
  Use when implementing, reviewing, or refactoring Agent Orchestrator behavior governed by
  docs/requirements.md and docs/specification.md. Trace applicable criteria and verify regression
  behavior proportionally to the change.
---

# Specification compliance

Paths in this procedure are relative to the repository root, not this skill directory.

1. Read `AGENTS.md`. Treat `docs/requirements.md` as authoritative product requirements and
   `docs/specification.md` as their verifiable specification. Implementation and passing tests do
   not override either document. Flag contradictions, missing criteria, ambiguous intent, or
   obsolete provisions explicitly; never silently weaken requirements to match code.
2. Before changing product behavior, identify applicable `REQ-*` IDs and each relevant acceptance
   criterion. Cite criterion source lines (or ID plus one-based criterion ordinal at the recorded
   specification revision). Include authoritative source statements not yet represented by an ID.
3. Trace real production callers and integration boundaries, including external mutations,
   persistence, ownership/concurrency, failure handling, restart, and recovery paths affected by the
   change. Do not infer integration from an unused helper or an isolated passing test.
4. Implement within task scope and architectural invariants. Keep engineering judgment in OpenCode;
   orchestration decisions must be explicit deterministic rules. Reconcile intended behavioral
   changes explicitly in both documents only when authorized.
5. Verify observable acceptance outcomes with meaningful success, boundary, failure, and recovery
   regression coverage as relevant. Run focused checks, then `yarn validate` for the final tree; run
   build or integration checks when relevant or requested. Keep investigation proportional: a narrow
   edit needs its affected paths, not an unsolicited full-repository audit.
6. Self-review against the identified criteria and production paths. Report IDs, source locations,
   executed commands/results, remaining gaps, and unverified external behavior. Distinguish static
   inference from demonstrated behavior. Never claim missing evidence is compliance.

For a requested systematic audit, load `spec-audit` instead; that procedure is read-only and does
not authorize implementing findings.
