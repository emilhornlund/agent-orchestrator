import { promisify } from "node:util";
import type { GitHubCredential } from "./github-credential-provider.js";
import { buildChildEnvironment } from "../process/child-environment.js";
import {
  appendBoundedOutput,
  getProcessRuntime,
  registerProcessSecrets,
} from "../process/process-runtime.js";
import { redactRegisteredSecrets } from "../security/redact-secrets.js";
import { containedCredentialRead } from "../process/contained-process.js";

export type ReadPullRequestFields = (options: {
  cwd: string;
  repository: string;
  number: number;
  credential: GitHubCredential;
}) => Promise<string>;

/** Read the API bytes directly: recent gh releases display-sanitize body text
 * even in JSON output, which cannot establish byte-exact publication acceptance. */
export const readPullRequestFields: ReadPullRequestFields = async (options) => {
  const runtime = getProcessRuntime();
  let token =
    options.credential.environment.GH_TOKEN ??
    options.credential.environment.GITHUB_TOKEN ??
    process.env.GH_TOKEN ??
    process.env.GITHUB_TOKEN;
  if (!token) {
    try {
      // Credential acquisition is intentionally in-memory only. Never record
      // the auth command's secret stdout or retain an error containing it.
      const { execFile } = await import("node:child_process");
      const dispatch = containedCredentialRead("gh", ["auth", "token", "--hostname", "github.com"]);
      const result = await promisify(execFile)(dispatch.command, dispatch.args, {
        cwd: options.cwd,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 16 * 1024,
        env: buildChildEnvironment("github", options.credential.environment),
        ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
      });
      token = result.stdout.trim();
    } catch {
      if (runtime.signal?.aborted)
        throw new DOMException("GitHub credential read aborted", "AbortError");
      throw new Error("GitHub authentication unavailable for exact publication readback");
    }
  }
  if (!token || /\s/u.test(token))
    throw new Error("GitHub authentication returned an invalid credential");
  registerProcessSecrets([token]);
  const timeout = AbortSignal.timeout(30_000);
  const signal =
    runtime.signal === undefined ? timeout : AbortSignal.any([runtime.signal, timeout]);
  let response: Response;
  try {
    response = await fetch(
      `https://api.github.com/repos/${options.repository}/pulls/${options.number}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal,
        redirect: "error",
      },
    );
  } catch {
    if (runtime.signal?.aborted)
      throw new DOMException("GitHub publication read aborted", "AbortError");
    throw new Error("GitHub API network error during exact publication readback");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `GitHub API ${response.headers.get("x-ratelimit-remaining") === "0" ? "rate limit " : ""}HTTP ${response.status} during exact publication readback`,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("GitHub API returned no publication response body");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let output = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      output = appendBoundedOutput(
        output,
        decoder.decode(part.value, { stream: true }),
        "stdout",
        4 * 1024 * 1024,
      );
    }
    output = appendBoundedOutput(output, decoder.decode(), "stdout", 4 * 1024 * 1024);
  } catch {
    await reader.cancel().catch(() => undefined);
    if (runtime.signal?.aborted)
      throw new DOMException("GitHub publication read aborted", "AbortError");
    throw new Error("GitHub API publication response could not be read completely");
  } finally {
    reader.releaseLock();
  }
  return redactRegisteredSecrets(output, [
    ...runtime.secretValues,
    ...options.credential.secretValues,
    token,
  ]);
};
