# P3 safe-execution verification evidence

This is the P3-T4 evidence record, not a claim that all P3 acceptance criteria
or realistic integrations have passed. It covers P3 (safe processes, diagnostics,
retention and credential boundaries); it does not implement or claim architecture
P4 external-mutation behavior. Synthetic credentials below are generated only by
tests. No private `.env`, ambient credential value, production service, or live
resource was inspected or used to mutate an external service.

## Reproduction and environments

- Candidate: `architecture/p3-safe-execution`, based on `bd02967` (`baseline2dc68c4`).
- Focused local command: `yarn test:p3`.
- Disposable container command: `yarn test:p3:container`. It builds
  `Containerfile.p3-test` and executes the same test command in a throwaway
  Podman container; no service credentials or mounted host state are provided.
- `test:p3` is deliberately focused: process runtime/descendants, bounded
  subprocesses, environment allowlists, sanitization, structured/raw logging,
  retention, Git/GitHub/Trello/OpenCode/email clients, startup and ownership,
  probes, runtime shutdown and relevant recovery dispatch. It is not the full
  workflow suite. It explicitly includes
  `tests/production-diagnostic-wiring.integration.test.ts`, which verifies
  production worker diagnostic persistence and restart reconstruction, plus
  real-child verbose validation/coverage/maintenance capture and output-limit
  integration coverage. `tests/git-client.test.ts` also creates a disposable
  SSH key with `ssh-keygen`, commits through the production default `GitClient`
  adapter, verifies the commit's `gpgsig` with `git verify-commit` and an
  allowed-signers file, and injects hostile indexed `GIT_CONFIG_*` variables
  to prove they do not override the configured key. It skips only when
  `ssh-keygen` is unavailable; the P3 test container installs `openssh-client`
  so this real signing case runs there.
- Retention additionally associates legacy session files with active run records
  using safe project/card-derived names, conservatively retains daily logs while
  any attempt is active, and scans runtime-root `process-executions` metadata.
  Only old executions with explicit terminal metadata are eligible for expiry;
  running, ambiguous, malformed, and unrecognized executions remain evidence.
  Typed `Logger.diagnostic` history stores enumerated domain codes, recovery
  decisions and constrained artifact references; it does not persist raw child
  error text.
- Linux host and rootless Podman are the only executed environment variants.
  Container process-group assertions treat Linux zombies as non-live (a
  container init may not reap orphaned zombies); production liveness checks
  already use this distinction. Actual executable descendants and write
  sentinels are still checked. The container uses its own Node 24 install.
  `podman run --rm` removes only the disposable container: the tagged P3 test
  image, context-sentinel image, and Podman build cache are not deleted.

## Results by P3 scenario and acceptance criteria

| Scenario / coverage                       | Result and executable evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Limits / missing level                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| VER-LOG-001-01; REQ-LOG-001 AC1–AC3       | **Passed at focused integration/test level.** `tests/p3-process-restart-evidence.integration.test.ts` creates durable production `RunStore` history in one child, restarts in a separate child, reconstructs transitions against the current record and appends a real Logger error. It also runs 30-day retention after restart with an active `Human Review` task and checks referenced evidence is retained while an unreferenced expired artifact is removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Process restart is exercised, not an actual host reboot or complete external Trello/GitHub lifecycle.                                                                                                                                                                                                                                                                                                  |
| VER-LOG-002-01; REQ-LOG-002 AC1–AC3       | **Passed for the requested deterministic adapter matrix.** `process-adapter-matrix.integration.test.ts` runs real Git, `gh`, OpenCode and CommandRunner child execution across nonzero, signal crash, partial stream, timeout, abort, and spawn-failure variants. Every launched fixture emits distinct stdout/stderr markers before its outcome; assertions require exact per-stream artifact contents, no cross-stream marker, ordered process start/finish artifact references, and raw-marker absence from Logger files/console output. `process-adapter-utf8-decoder.test.ts` complements it with mocked-child bytewise Buffer events on independent stdout/stderr streams for Git, `gh`, and OpenCode, checking exact redacted results/artifacts and terminal replacement characters. The real-child matrix also tests registered Unicode secrets and incomplete terminal UTF-8. Overflow and recorder-failure fixtures assert both artifact streams and evidence-failure metadata; pipe-closed SIGTERM-resistant descendants are exercised as well. | The matrix calls the real Logger with a deliberately test-authored safe diagnostic summary and controlled artifact reference; it does not establish that every production caller constructs summaries that way. CommandRunner uses a shell: command-not-found is exit 127 / `nonzero`, not native spawn-failure. Not every platform/signal/output combination or live binary compatibility is covered. |
| VER-LOG-003-01; REQ-LOG-003 AC1–AC3       | **Passed at unit/integration level.** `tests/log-retention.test.ts` covers the 30-day default, configured retention, cutoff boundary and active records/artifact references. `p3-process-restart-evidence.integration.test.ts` additionally restarts a separate child process, rereads a production RunStore `human-review` record, and proves an old referenced artifact survives while an unreferenced expired artifact is removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | No actual host reboot/container restart or full production deployment was run.                                                                                                                                                                                                                                                                                                                         |
| VER-SEC-001-01; REQ-SEC-001 AC1–AC3       | **Passed for synthetic environments and local protected-file checks.** `child-environment.test.ts` checks allowlists for `command`, `flock`, `git`, `github`, and `opencode`, unrelated env exclusion, project-specific App/PAT inputs and selected OpenCode provider credentials. `github-app-authenticator.test.ts`, `github-credential-provider.test.ts`, `environment.test.ts`, and client auth-error tests exercise protected App key and sanitized error behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | No live authentication or external authorization result is asserted.                                                                                                                                                                                                                                                                                                                                   |
| VER-SEC-002-01; REQ-SEC-002 AC1–AC5       | **Passed for the feasible deterministic channel matrix and scoped boundary behavior.** The surface inventory below links production-boundary tests for process evidence, prompts, Trello/GitHub content, SMTP and diagnostics. Registered-secret form handling is separately tested in `redact-secrets.test.ts`; attachments containing a registered raw credential are refused before publication. Synthetic canaries only; tests do not print their values.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Not a single end-to-end external service ledger, nor proof that every representation is covered on every surface. Arbitrary transformations, unknown secrets, data read directly from repository files, and future/unexercised routes are out of scope. Realistic outbound capture remains blocked (see below).                                                                                        |
| VER-SEC-003-01; REQ-SEC-003 AC1–AC3       | **Passed for simulated identities.** Credential provider/authenticator tests model independent App and PAT selection, scoped auth errors, project identity and continued other-project operation. `child-environment.test.ts` verifies values do not cross process boundaries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Actual App + PAT GitHub operations and actor-attributed service ledger are **blocked** without disposable GitHub resources, isolated App/PAT credentials and explicit mutation authorization.                                                                                                                                                                                                          |
| VER-REC-005-01; REQ-REC-005 AC1, AC4      | **Passed for the deterministic production shutdown boundary.** `tests/p3-shutdown.integration.test.ts` starts actual `runStartup` in a child process with controlled Trello/GitHub/OpenCode adapters, a real disposable Git source/worktree and uncommitted tracked edit, an eligible card, a persisted RunStore attempt, and a CommandRunner-owned process group with a live descendant. After SIGTERM it checks no late card claims, process-group drain before release, retained dirty Git bytes and pinned/session references, and lease reacquisition; a second production startup resumes the same active attempt and cannot create a second claim. A separate startup-scoped static dispatch case persists process-termination ambiguity and fences reacquisition.                                                                                                                                                                                                                                                                                  | Offline services and one host process namespace; not a live Trello board, actual host reboot, or P5 recovery judgment.                                                                                                                                                                                                                                                                                 |
| VER-REC-006-01; REQ-REC-006 AC1, AC3, AC4 | **Passed for adapter-level process outcomes, partial for task recovery.** The parameterized production adapter matrix exercises timeout/abort and records terminal metadata across Git, `gh`, OpenCode and CommandRunner; SIGTERM-resistant closed-pipe descendants are checked through each adapter. Flock separately covers real nonzero, missing executable, hung timeout, real contention, release and reacquisition.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Durable task-edit/log preservation and advisory-to-PR publication after timeout are not established end-to-end by this matrix.                                                                                                                                                                                                                                                                         |

### Child-process case inventory and controls

| Case                                          | Evidence in focused suites                                                                                                                                                                                                      | Qualification                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Nonzero and raw stdout/stderr evidence        | `process-adapter-matrix.integration.test.ts`: actual production adapters and synthetic executables                                                                                                                              | Checks status metadata and output artifacts, not all possible output sizes/encodings.                                                     |
| Spawn failure                                 | Git/`gh`/OpenCode native spawn errors; CommandRunner command-not-found through its shell                                                                                                                                        | The shell contract reports 127 as a normal nonzero result, not native spawn-failure.                                                      |
| Timeout / abort                               | Matrix timeout cases for Git/`gh`/OpenCode/CommandRunner use 100 ms bounds; abort cases allow 30 seconds for the runner's configured 5-second process-group termination grace. Flock includes a 50 ms hung timeout.             | SIGTERM-responsive command timeout; resistant descendants have separate sentinel case.                                                    |
| Crash/signal and partial stream               | Matrix uses self-SIGTERM fixtures and chunked stdout/stderr; abort fixtures leave distinct partial data on both streams before cancellation and schedule late chunks that must not appear. Raw metadata includes signal/status. | Signal/status fields differ by direct-spawn versus shell adapter; a shell may append its own termination diagnostic after fixture stderr. |
| SIGTERM-resistant descendant / closed pipes   | Matrix runs through every adapter; a closed-pipe leader leaves a TERM-resistant sentinel writer                                                                                                                                 | Sentinel is unchanged after each operation settles; executed locally and in Podman.                                                       |
| Git clone, compatibility probes, `flock`      | `ensureRepository` local clone and `validateGitAndOpenCode` use real `CommandRunner`; lease acquires real/faulted `flock` processes                                                                                             | Local deterministic repository/probes; not external GitHub compatibility or multi-host coordination proof.                                |
| Ambiguous termination and event-loop liveness | Startup-scoped static dispatch drives `drainProcessGroup` through actual ambiguity handler and durable lease marker; separate retry test has an unref'd control interval                                                        | Does not execute a complete runStartup task worker under an independently launched service process.                                       |

### Canary surfaces and representation forms

The exact synthetic forms exercised by the sanitizer tests are: literal; URL
percent-encoding and form-style `+`; Base64 and unpadded Base64URL; JSON string
escaping; recognized credential field patterns (including bearer credentials);
and chunk splits at every position for the tested registered forms. This means
the sanitizer function has representation-matrix evidence; it does **not** mean
each individual surface has had every form independently replayed.

| Surface/boundary                                                           | Named deterministic evidence                                                                                                                                                | Forms/data and preserved behavior established                                                                                                                                                                                                                                  | Explicit limit                                                                                                                                                                          |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode prompt passed to `OpenCode.run`                                   | `tests/opencode-client.test.ts` and `tests/opencode-streaming.test.ts`                                                                                                      | Registered values are sanitized at the actual spawn argument boundary; provider/model and session arguments remain operational. Streaming stdout/stderr are redacted before result and process evidence; session logging is exercised.                                         | Does not prove what a remote model/provider retains or prevent an agent from independently reading repository files.                                                                    |
| Attachments                                                                | `tests/materialize-card-attachments.test.ts`                                                                                                                                | Actual streamed bytes are checked for registered credential bytes, including a credential split between chunks; a match fails with a fixed diagnostic and publishes neither managed file nor manifest.                                                                         | Deliberately only known registered raw credential byte sequences. No general file-secret scanner, encoded-form detector, or claim about arbitrary content.                              |
| Raw process output, metadata, session log, logger daily/history            | `tests/process-adapter-matrix.integration.test.ts`, `tests/opencode-streaming.test.ts`, `tests/logger.test.ts`, `tests/session-log.test.ts`, `tests/redact-secrets.test.ts` | Sanitizer unit tests cover literal/percent/form/Base64/Base64URL/JSON representations and all splits; controlled process capture checks output artifacts/metadata, session text and logger persistence are tested at their writers.                                            | Representation coverage is joined across sanitizer and surface tests; no assertion that every form was injected through every artifact writer in one test.                              |
| Trello comments and content                                                | `tests/trello-client.test.ts`                                                                                                                                               | Registered PEM canary is removed from outbound card content while key/token authentication parameters and the selector/path are preserved.                                                                                                                                     | Test is synthetic HTTP capture; does not exercise a live board or every mutation endpoint independently.                                                                                |
| GitHub PR title/body, GraphQL review-thread reply, REST conversation reply | `tests/github-client.test.ts`                                                                                                                                               | Registered PEM literal in title, Base64URL body, and literal/percent/Base64URL review reply forms are redacted in actual `gh` arguments; `--head` and thread selectors remain intact. The GraphQL reply and REST conversation reply receipts are validated after sanitization. | Status operations have adapter coverage but no user-content canary is applicable/injected there; no shared form matrix covers every PR/status/reply route. Synthetic `gh` capture only. |
| SMTP subject/text and notification errors                                  | `tests/smtp-email-notifier.test.ts`, `tests/email-notifier.test.ts`                                                                                                         | Actual local SMTP capture checks registered literal subject and Base64URL text canaries are redacted while From/To routing remains intact; sanitized notifier diagnostics are also exercised.                                                                                  | Current `EmailMessage` supports subject/text, not HTML, so HTML is absent scope. Does not assert every representation on every field, relay behavior, or recipient delivery.            |
| Recovery/operator reports and failures                                     | `tests/run-startup.test.ts`, `tests/task-session-dispatch.test.ts`, `tests/bounded-diagnostic.test.ts`, plus client error tests above                                       | Controlled recovery paths and bounded external diagnostics are tested; client errors are sanitized at boundary-specific handlers.                                                                                                                                              | Not every report/error construction path is supplied each canary form; no live failure/recovery ledger.                                                                                 |

Canary sources considered by this matrix are synthetic environment/provider
credentials, PAT-like GitHub credentials, App-token-like dynamically registered
credentials, and a synthetic protected-PEM-shaped value. Authentication and
operational selectors (for example Trello key/token, GitHub head branch,
provider/model and session IDs) must remain usable and are not treated as
outbound user content. `tests/child-environment.test.ts` additionally checks
the process-family manifests, isolation of two supplied project GitHub
identities, selection of one OpenCode provider's auth variables, and exclusion
of unrelated credentials. There is no universal secret scanner: repository
files are agent-readable in ordinary writable runs. OpenCode child environments
are allowlisted to the selected model provider, while `buildOpenCodeConfigContent`
denies question prompts and in read-only mode denies edit/bash/external-directory
permissions; these are scoped mitigations, not proof against direct file reads
or all agent behavior. Realistic outbound capture is still blocked, as described
below.

## Execution record

Latest rerun: `yarn test:p3` **passed** (36 files, 584 tests),
`yarn validate` **passed** (lint, format check, typecheck, and 142 files / 1,528
tests), and `yarn test:p3:container` **passed** (36 files, 584 tests). An
earlier `yarn validate` attempt during final housekeeping failed: besides
formatting/unused-variable findings in the in-progress GitHub client changes,
two GitHub CI observation tests exposed that stale-SHA failures no longer
contained their established safe `different commit SHA` diagnostic. Those
findings were fixed (including preserving process-output provenance), then
validation was rerun successfully; the historical failure is recorded here,
not represented as a pass or erased by the later successful run. The focused P3 command now explicitly includes
`tests/inspect-primary-session.test.ts`. That suite includes a real malformed
OpenCode child response and verifies a cause-free safe error, execution/stdout
artifact references, and raw-marker confinement to the stdout artifact. The
suite also exercises malformed `gh` JSON from an actual child through
`observeTaskSessionReviewCards` during worker polling under
`ProjectRunAuthority`; it checks typed failure provenance, raw-marker
confinement to the stdout artifact, absence from history, daily logs and
console output, and that this malformed response is classified as
non-retryable and handled once (there is no retry). This is distinct from the
separate production-wired `production-diagnostic-wiring.integration.test.ts`
scenario where a genuine `gh` HTTP 503 is classified as retryable: it records
retry-scheduled decisions for attempts 1 and 2, then preserves state at the
bounded third-attempt exhaustion. The production
diagnostic retention scenario expires the actual worker's daily log from
configured `storageRoot` only after `completeRefinement` records a canonical
verified terminal transition; canonical history and retry/exhaustion, process
diagnostic and artifact-reference evidence are reread in a child process. The
retention unit oracle separately proves a valid expired finished execution is
preserved when an active attempt references its real stderr file, while its
otherwise equivalent unreferenced execution expires. The container context
sentinel also passed (six synthetic sentinels excluded; four allowlisted COPY
instructions retained).

The synthetic context check created six throwaway config, `.env`, log, history,
attempt and key sentinel files in a temporary build context; it verified all
six were absent from the image and that the four explicit COPY instructions
retained required sources. `config.example.yaml` is explicitly included because
the runtime-lifecycle suite reads that non-secret example. The production
Containerfile does not copy `config.yaml`, `.env*`, logs/history/runtime state,
or protected-key directories. The context-check image, main P3 image and Podman
build cache remain local. `podman run --rm` removed only the disposable test
container; it did not delete any image or cache.

Final test environment: Linux x86_64, rootless Podman 5.8.9, `crun` 1.28,
Node `v24.18.0`, and Debian Git 2.39.5 in `node:24-bookworm-slim`. Tests emitted
expected synthetic Git operations and sanitized operator warnings. No private
config/history/key files were read or copied; no live services, production
resources, or external credentials were used.

## Blocked realistic verification (not waived)

Realistic `VER-SEC-003-01`, realistic outbound portions of `VER-SEC-002-01`,
and full realistic logging/shutdown claims are **BLOCKED**, not passed. The
environment did not provide explicit authorization, disposable Trello Free
boards, disposable GitHub repositories/PRs, an isolated GitHub App and PAT,
OpenCode service credentials/session, or a controlled SMTP destination.
No private `.env` was inspected and no ambient credential was used. To close
these levels, provide an expressly authorized disposable two-project fixture,
unique App/PAT actors and repository permissions, an OpenCode model/session,
a sink mailbox, documented outbound-capture/actor ledger, and permission to
create/update/close only those named disposable resources. Record versions and
reconcile all resulting resources before the run; never substitute production
resources.

Container evidence is Node/Linux process and filesystem parity for the selected
suite only. It is not Docker production deployment, SELinux policy, multiple
machine coordination, or a substitute for the blocked live-service run.
