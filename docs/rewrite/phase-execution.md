# Temporary rewrite delivery workflow

This document exists only for the rewrite and is removed at its completion.
Everything in `docs/rewrite/` is temporary implementation guidance. Keep
all rewrite planning here; do not link it from permanent product documentation or
put rewrite instructions into `README.md`, `AGENTS.md`, source comments or tests.
Start with `phase-status.md`, the selected `p<N>-execution.md`, and the relevant
permanent [requirements](../requirements.md)/[specification](../specification.md).
Use `rewrite-plan.md` only for architecture/boundaries and `p6-decisions.md` for
approved policy when relevant. There are no historical evidence/audit prerequisites.
Requirements and specification define the product target. This workflow replaces
the former readiness, evidence, manifest and qualification process.
Runtime recovery evidence and repository safety invariants remain required.

## One complete phase at a time

1. **Prepare once.** Inspect current progress, branch/diff, selected guide and relevant
   specification/code/tests. Establish the remaining behavior, concrete starting
   files/callers, implementation order, state/migration contracts, known pitfalls,
   focused checks and exclusions. Break the selected phase into small ordered tasks,
   each delivering one complete observable behavior including callers, compatibility
   and a meaningful regression. Split independent behavior, not helper from caller.
   Update the existing guide if useful; no new planning file or preflight stage.
2. **Implement one task at a time.** Work through that plan sequentially, using the
   existing implementation context. Complete production wiring, compatibility,
   focused tests and appropriate typecheck before presenting the task for review.
3. **Review the completed task before continuing.** Inspect its code against the
   assigned specification criteria and affected callers/state/tests. Correct concrete
   findings through small tasks; re-review corrections and affected paths only.
   Pending later tasks are outside that review. No evidence report or full-suite
   run is required per task. Continue automatically once scoped review/checks pass.
4. **Checkpoint when authorized.** An explicit session instruction may authorize
   small local commits after reviewed tasks. Stage only the intended task changes,
   preserving unrelated/preexisting work and user staging. A task commit is a local
   checkpoint, not full-phase approval. Without authorization, leave changes unstaged
   and uncommitted. Never automatically squash, amend or rewrite checkpoint history.
5. **Review final integration.** Check the combined selected-phase changes for full
   scoped specification coverage, cross-task contracts, migration/restart interaction,
   missing behavior and regressions. Reuse earlier task reviews for local correctness
   rather than repeating them without a concrete concern. Fix findings in small
   dependency-ordered tasks and review their affected paths. If failures are widespread,
   diagnose the common contract/planning problem and revise the task plan before
   continuing; never assign a giant undifferentiated correction backlog.
6. **Validate and stop.** After corrections, run `yarn validate` on the final change.
   Reuse success for the same tree. Update one short progress entry and stop before
   the next phase. Keep final corrections in small separate checkpoints when
   authorized; otherwise leave them for user review. No automatic push or PR.

No separate readiness register, criterion/variant matrix, evidence archive, tree
hashes, live-service qualification or release-acceptance process is required.
Use the specification and existing tests to select meaningful scenarios. Do not
replace normal testing with paperwork or add permanent rewrite-specific harnesses.

Completion means the selected behavior is integrated, meaningful regressions and
full validation pass, and concrete in-scope defects are resolved. Genuine blockers
and unimplemented behavior stay visible. Do not fabricate successful checks, ignore
safety defects or reopen already approved product decisions.

Some specification clauses describe demonstration/qualification rather than
application behavior, notably the realistic-baseline parts of REQ-TST-001/003.
Keep meaningful automated integration coverage, but report unexecuted external
qualification separately from implementation defects. It does not block this
implementation workflow or require a new evidence record. Implementation-complete
does not mean every qualification clause was demonstrated; never claim that it does.

## Keep the rewrite out of the product

- Existing rewrite guides and progress are temporary. Update them in place; do not
  create more phase records, evidence reports, retrospectives or review documents.
- Name new code, tests, fixtures and comments after product behavior, never after
  rewrite steps. The delivery plan must not become application architecture.
- At the final rewrite step, remove temporary planning/evidence documents, roadmap,
  audit, decision/preflight/status files and their links. Transfer still-useful
  behavior, architecture and operator guidance to ordinary product documentation.
- Remove references to rewrite delivery phases, such as rollout labels, temporary
  planning links and rewrite-step names in code/tests. Preserve legitimate application
  lifecycle phases, runtime fields named `phase`, and their product documentation.
  The cleanup is semantic, not a ban on the word `phase` or ordinary Git rewriting.
  Do not rename domain concepts or migrate persisted formats merely to erase a word.
- Check the final tracked tree for remaining rewrite-specific references and broken documentation
  links. Git history retains removed planning; no in-repository history archive is
  needed.
- After final cleanup deletes this folder, do not recreate it to record progress
  or results. Finish from the selected scope and permanent specification; report
  the final status in the handoff response only.

Preserve work, source-checkout protection, one writer per project, unknown-state
fences and truthful external-operation handling. No automatic merge, force-push or
destructive cleanup. Leave changes uncommitted for user review unless the user
explicitly requests a commit. Git publication/deployment requires authorization.
