import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { readPullRequestFields } from "../src/github/read-pull-request-fields.js";
import { configureProcessRuntime } from "../src/process/process-runtime.js";
import { GitHubClient, isRetryableGitHubError } from "../src/github/github-client.js";
import { GitHubCredentialProvider } from "../src/github/github-credential-provider.js";

const fetchMock = vi.fn<typeof fetch>();
const options = {
  cwd: "/repo",
  repository: "owner/repo",
  number: 4,
  credential: {
    mode: "github-app" as const,
    environment: { GH_TOKEN: "fixture-token" },
    secretValues: ["fixture-token"],
  },
};
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  configureProcessRuntime({ runtimeRoot: "/tmp/opencode", signal: new AbortController().signal });
});
afterEach(() => vi.unstubAllGlobals());

it("verifies exact body bytes without gh display rewriting, using the scoped credential", async () => {
  const body = "literal \\u001b[32m and actual \u001b[32m; café\n";
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ title: "Task", body, draft: true })));
  const credentialProvider = new GitHubCredentialProvider();
  vi.spyOn(credentialProvider, "resolve").mockResolvedValue(options.credential);
  const client = new GitHubClient(undefined, credentialProvider);
  await expect(
    client.getPullRequestPublicationFields({
      cwd: "/repo",
      repository: "owner/repo",
      pullRequestUrl: "https://github.com/owner/repo/pull/4",
    }),
  ).resolves.toEqual({ title: "Task", body, isDraft: true });
  expect(fetchMock).toHaveBeenCalledWith(
    "https://api.github.com/repos/owner/repo/pulls/4",
    expect.objectContaining({
      redirect: "error",
      headers: expect.objectContaining({ Authorization: "Bearer fixture-token" }),
    }),
  );
});

it("redacts registered credentials from the returned API payload", async () => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ title: "Task", body: "fixture-token", draft: false })),
  );
  const result = await readPullRequestFields(options);
  expect(result).not.toContain("fixture-token");
  expect(JSON.parse(result)).toMatchObject({ body: "[REDACTED]" });
});

it.each([401, 403, 429, 503])(
  "reports HTTP %s without response bodies or credentials",
  async (status) => {
    fetchMock.mockResolvedValue(new Response("private fixture-token", { status }));
    const error = await readPullRequestFields(options).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`HTTP ${status}`);
    expect((error as Error).message).not.toContain("fixture-token");
    expect(isRetryableGitHubError(error)).toBe(status === 429 || status === 503);
  },
);

it("preserves network failures as retryable uncertainty without retaining raw errors", async () => {
  fetchMock.mockRejectedValue(new Error("fixture-token connection error"));
  const error = await readPullRequestFields(options).catch((cause: unknown) => cause);
  expect(isRetryableGitHubError(error)).toBe(true);
  expect((error as Error).message).not.toContain("fixture-token");
});

it("rejects oversized responses rather than verifying a prefix", async () => {
  fetchMock.mockResolvedValue(new Response("x".repeat(4 * 1024 * 1024 + 1)));
  await expect(readPullRequestFields(options)).rejects.toThrow("could not be read completely");
});
