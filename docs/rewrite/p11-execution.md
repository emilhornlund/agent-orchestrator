# P11 — final integration and removal of rewrite scaffolding

Temporary implementation guide. Follow [delivery workflow](phase-execution.md).
Prepare small tasks for one bounded scope from the actual P10 tree and requirements/
specification. Include REQ-ENV-001, REQ-REC-005, REQ-CFG-002/003/005, REQ-SEC-001/003,
REQ-TST-001–003 and remaining cross-workflow criteria. Close actual product gaps and
cleanup through reviewed small tasks, then inspect final integration. No release-evidence project.
REQ-TST evidence-only clauses remain separate qualification limits, not new coding
or acceptance tasks. Keep executable workflow/failure tests and honest check results;
do not claim a realistic baseline was demonstrated if it was not run.

## Implementation scope

Current bounded order: supported state/restart and production container packaging
(including shared-root corrupt-record isolation), standalone product guidance,
then temporary-guidance cleanup and final integration validation. Container checks
must distinguish image/tool success from host nested-isolation policy denial.

1. Check cross-workflow integration using existing deterministic suites: initial
   normal/draft publication, feedback, bounded CI and additive maintenance, human
   terminal outcomes, clean retries, refinement and shutdown/restart recovery.
   Add tests only for meaningful missing behavior or concrete integration risks.
2. Finish supported prior/current record migration and local/container deployment
   behavior. Preserve unsupported/corrupt originals and isolate affected projects.
   Use Podman for relevant container checks on this host; no permanent live harness.
3. Retire redundant legacy dispatch/authority once supported active state can migrate
   or drain safely. No route may reinstate auto-merge, force-push, unsafe cleanup or
   quality-approval publication gates. Keep useful behavior-named regression fixtures.
4. Make configuration, workflow, operations and recovery documentation describe the
   actual product, supported behavior and limitations. Normal operation/recovery
   must not rely on internal-file editing or rewrite guides.

## Mandatory rewrite cleanup

- Remove the entire temporary `docs/rewrite/` directory after extracting useful
  technical guidance, including roadmap, decisions and progress. Preserve useful guidance
  in ordinary product documentation before deleting; Git history is the archive.
- Remove delivery terminology from production code, tests, fixtures, comments,
  schemas, filenames and permanent documentation where it refers to the rewrite.
  Preserve legitimate application lifecycle phases, existing `phase` fields and
  behavior names. Do not perform cosmetic runtime/schema migrations to remove words.
- Remove any remaining links and instructions that depend on deleted planning.
  Permanent documentation and `AGENTS.md` must already be independent of this folder.
  Keep requirements/specification and useful product
  verification guidance, rewritten without delivery vocabulary.
- Search tracked contents and filenames for remaining rewrite-phase labels and
  temporary planning references after deleting this guide. Classify matches by
  meaning: application lifecycle phases and ordinary Git-history rewriting are valid
  product concepts and must not be removed by a blanket text replacement.

## Finish

Follow the delivery workflow for focused task reviews and small corrections, then
final integration review and `yarn validate` on the final tree. Check documentation
links and terminology cleanup. Small local checkpoints require explicit session
authorization; otherwise leave changes for user review. No automatic push, PR, merge,
deployment or live-service qualification. Report actual behavior, checks and any
remaining gaps honestly; do not create a final evidence report.
