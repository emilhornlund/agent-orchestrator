# P6 readiness snapshot

This is a bounded preflight record, not P6 implementation or full qualification.
The user requested that preflight exploration stop and the work be wrapped up.
The four [P6 decisions](p6-decisions.md) are approved; no repeat approval is needed.

## Observed baseline and tooling

- Checkout: `architecture/p5-recovery-first`, source HEAD
  `f8ac2eaa3991a3c2b6b8b4b98945e06076140050`, with the intentional documentation
  working diff. No source implementation changes were made in this readiness work.
- PR #218 was observed OPEN at that source head, targeting `main`; merge was not
  assumed or performed.
- Node 24.18.0, Git 2.56.0, gh 2.103.3, OpenCode 1.18.35, Podman 5.8.9,
  bubblewrap 0.12.0 and systemd 259 are locally available.
- GitHub authentication returned the expected account identity. No releases/tags
  were returned by the scoped inventory queries. This does not identify a currently
  deployed application version or imply that no deployment exists.

## Temporary filesystem-boundary probes

Executed `node /tmp/opencode/p6-readiness-probe.mjs`, using disposable real local
Git source/worktree fixtures only. Result artifact:
`/tmp/opencode/p6-readiness-PttIGs/result.json`.

| Probe                                                                                            | Observed result                                                                                              | Limit                                                                                        |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Local bubblewrap, private namespaces and read-only root with writable owned task path            | Task edit succeeded; source-file and source-index writes were denied; source bytes/index/HEAD/refs unchanged | Candidate mechanism, not production OpenCode integration or a complete negative-write matrix |
| Existing rootless Podman image, network disabled, read-only source mount and writable task mount | Same positive task/negative source/index observations; source identities unchanged                           | Outer container mount capability, not proof of the current deployed agent boundary           |
| Nested container namespace availability                                                          | User/PID namespace operation succeeded; bubblewrap binary absent in that image                               | Feasibility information only; no package installed or execution mechanism selected           |

There were no model calls, Trello/GitHub mutations, production resource accesses or
new service purchases. Credential-file availability was inspected as metadata only;
contents were not read or logged. The existing OpenCode auth-store file was present;
actual model access and disposable Trello/test-inbox provisioning remain unverified.

## Remaining engineering work

- Integrate and prove the selected source-protection boundary against actual writable
  OpenCode dispatch, including allowed runtime/auth/log locations.
- Investigate C2 containment/liveness with an actual escaped-descendant/supervisor-loss
  test and durable recovery evidence. This probe did not establish it; no unsafe
  retry is authorized and it is not proven that a compatible solution is unavailable.
- Map approved recovery accounting and rubric to concrete fixtures and the finite
  P6 launch manifest.
- Identify the deployed upgrade writer/version and produce the supported actual
  artifacts alongside P5 PR #218 state.
- Provision and execute the authorized finite isolated live test plan; account
  availability and authorization are not passing live evidence.

These are engineering/provisioning tasks, not outstanding user approvals for the
four decisions. Later P7–P9 A2/A5 choices retain their own owners. No P6 feature work,
Git commit/push, PR merge or deployment was performed by this preflight.
