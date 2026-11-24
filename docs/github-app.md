# GitHub App setup and permissions

Agent Orchestrator can authenticate separately to GitHub for each project using a GitHub App. This
is the recommended option for a dedicated bot identity and repository-scoped access. A project
without `repository.githubApp` continues to use ambient GitHub CLI/Git authentication. When an App
is configured, its installation token takes precedence: **a failed App operation never falls back to
`GH_TOKEN` or a personal access token**.

This guide covers the repository permissions needed by the current workflow, installing the App,
verifying real access, and diagnosing permission failures. It does not change application behavior
or configure automatic PR merging.

## Repository permission matrix

Select the following under **Developer settings → GitHub Apps → [your App] → Permissions & events →
Repository permissions**.

| GitHub App permission | Access                           | Why                                                                                                                               |
| --------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Contents**          | **Read and write**               | Clone/fetch, create and push task branches, read workflow source files, and update repository content                             |
| **Pull requests**     | **Read and write**               | Create and update PRs, read and respond to review feedback, and maintain PR metadata                                              |
| **Actions**           | **Read-only**                    | Discover workflow runs and jobs, and read CI job results and logs                                                                 |
| **Checks**            | **Read-only**                    | Inspect check runs and failure annotations                                                                                        |
| **Commit statuses**   | **Read-only**                    | Inspect commit-scoped status contexts                                                                                             |
| **Administration**    | **Read-only**                    | Read branch-protection requirements (including required status checks) for complete CI expectations                               |
| **Issues**            | **Read and write** (recommended) | Manage issue-style PR conversation comments; GitHub also permits these comment operations through sufficient Pull requests access |
| **Workflows**         | **Write** (when needed)          | Allow the bot to create or modify files under `.github/workflows/`                                                                |

**Actions** and **Workflows** are distinct permissions. Actions Read-only is enough to observe
GitHub Actions; changing workflow YAML files requires Workflows Write in addition to repository
content access. Workflows Write is recommended when tasks may change CI configuration, as in a
general-purpose coding agent.

**Administration Write is not required.** Administration Read is used for the branch-protection
status-check read. If those rules are inaccessible, the orchestrator may have incomplete CI
expectations; a missing rule source is not proof that CI passed. The Issues grant is recommended for
installations that want explicit issue-comment access, but Pull requests access may also authorize
PR conversation comments. GitHub Apps receive **Metadata: Read-only** implicitly.

Permissions should be restricted to the repositories the App needs. Other grants (for example,
repository secrets, deployments, packages, or organization administration) are not part of this
baseline; add them only for a separately reviewed workflow.

References:

- [GitHub: Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [GitHub: Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
- [GitHub: Creating a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)

## Create, install, and configure

1. In GitHub **Settings → Developer settings → GitHub Apps**, create an App (or open an existing
   one). Set its name and select the permissions above. The orchestrator polls GitHub, so an
   incoming webhook endpoint is **not** required for the current workflow.
2. Generate a **private key** in the App's settings. Store the PEM file outside the repository and
   restrict access to the service identity. Mount it into the container if running under Docker; the
   configured path is the **runtime** path, not necessarily the host path.
3. Install the App on the intended GitHub account. Select **Only select repositories** if possible,
   and grant it access to each repository configured in the orchestrator. Record the numeric App ID
   and the installation ID; these are different values.
4. Configure `repository.github` and `repository.githubApp` for each project:

   ```yaml
   projects:
     - id: example
       repository:
         github: "owner/repository"
         githubApp:
           appId: "123456"
           installationId: "987654"
           privateKeyPath: "/run/secrets/agent-orchestrator-github-app-key"
   ```

5. Check that the private key is readable by the **runtime service identity**. Keep it out of Git
   history, logs, PRs, and task context. The App creates a short-lived installation token scoped to
   the configured repository.

See [Configuration](configuration.md#github-authentication-modes) for the authoritative schema and
[Operations](operations.md) for runtime behavior.

### When changing permissions later

1. Change the App's repository permissions and save.
2. **Approve the updated permissions on the App installation** in **Settings → Applications →
   Installed GitHub Apps** for the account that owns the repositories. An App's edited permission
   list alone is not enough.
3. Verify the installation's **actual** granted permissions and endpoint access as described below.
4. Installation tokens are cached in the running orchestrator until shortly before expiry. After
   approval, allow the cache to refresh, or restart the service **only when no task is executing**.
   Preserve task state, worktrees, context volumes, and open PRs; no new App key or PAT is
   necessary.

## Verify the installed App, not an ambient PAT

`gh auth status`, startup repository-access checks, and a successful clone do **not** establish
access to Commit statuses, Checks, Actions, or branch protection. The App must be installed on the
**target repository**, and its _installation token_ (not the operator's `GH_TOKEN`/PAT) must have
the required permissions.

1. Create an **App JWT** using the App ID and PEM key, then exchange it with
   `POST /app/installations/{installation_id}/access_tokens`. Scope the request to the target
   repository with a `repositories` array containing the repository name (without the owner). See
   [GitHub: Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).
2. Inspect the exchange response's `permissions` object. A baseline installation should report
   `contents: write`, `pull_requests: write`, `actions: read`, `checks: read`, `statuses: read`, and
   `administration: read`. Check `issues: write` and `workflows: write` when those capabilities are
   enabled. `write` also satisfies a `read` requirement. Verify the installed repository scope
   separately.
3. For a direct read-only API smoke test, use that **short-lived installation token** in a temporary
   shell session. The following commands do not mutate GitHub state:

   ```sh
   # Paste the App *installation token* at the hidden prompt, never in shell history.
   read -r -s -p "GitHub App installation token: " GH_TOKEN
   printf "\n"
   export GH_TOKEN

   # Replace owner/repository and HEAD_SHA with the actual repository and a full SHA.
   gh api 'repos/owner/repository/commits/HEAD_SHA/statuses?per_page=1' --silent
   gh api 'repos/owner/repository/commits/HEAD_SHA/check-runs?per_page=1' --silent
   gh api 'repos/owner/repository/actions/runs?per_page=1' --silent
   gh api 'repos/owner/repository/branches/main/protection/required_status_checks' --silent

   unset GH_TOKEN
   ```

   The first three endpoints should return HTTP 200 when their read permissions are granted. A
   branch-protection read may return 404 if no branch protection exists; verify the rules separately
   rather than treating 404 as evidence of permission success. These read tests **cannot** prove
   write permissions: inspect the token's `permissions` object, and perform any write test only on
   an explicitly approved test repository/branch.

4. Never print, paste, or commit a JWT, installation token, or PEM key. Do not replace the installed
   App token with a PAT to make a failed test pass.

## Troubleshoot access failures

| Symptom                                                                         | Check                                                                                          |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `HTTP 403: Resource not accessible by integration` on `/commits/{sha}/statuses` | **Commit statuses: Read-only**                                                                 |
| The same 403 on `/commits/{sha}/check-runs` or check annotations                | **Checks: Read-only**                                                                          |
| The same 403 on `/actions/runs`, jobs, or job logs                              | **Actions: Read-only**                                                                         |
| The same 403 on branch-protection `required_status_checks`                      | **Administration: Read-only** and whether the branch is protected                              |
| Cannot update `.github/workflows/` files                                        | **Workflows: Write**, plus **Contents: Write**                                                 |
| PR creation, review, or update is forbidden                                     | **Pull requests: Read and write**                                                              |
| PR conversation comment is forbidden                                            | **Pull requests** or **Issues: Write**, depending on the endpoint                              |
| An updated App permission still returns 403                                     | Installation approval, repository selection, and cached token freshness                        |
| App token exchange fails                                                        | App ID, installation ID, private-key contents/mount, clock, and installation repository access |

For REST authorization errors, inspect GitHub's `X-Accepted-GitHub-Permissions` response header when
available. It identifies accepted permissions for the endpoint. Avoid guessing from
`gh auth status`: that command may describe ambient credentials rather than the project's App
installation token.

A 403 is an **access/configuration problem**, not proof that the PR or task should be discarded.
Preserve the original worktree, pending review feedback, and durable attempt evidence while
correcting permissions.
