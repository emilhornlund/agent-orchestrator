import { generateKeyPairSync, verify } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createGitHubAppJwt,
  GitHubAppApiError,
  GitHubAppAuthenticator,
  GitHubAppConfigurationError,
  GitHubAppCredentialError,
  GitHubAppNetworkError,
  type SignGitHubAppJwt,
} from "../src/github/github-app-authenticator.js";

const githubApp = {
  appId: "123456",
  installationId: "987654",
  privateKeyPath: "/secrets/github-app.pem",
};
const repository = "owner/repository";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const privateKeyPem = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

function response(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), { status });
}

function tokenResponse(token: string, expiresAt: string): Response {
  return response({ token, expires_at: expiresAt });
}

describe("GitHubAppAuthenticator", () => {
  it("creates a GitHub-compatible RS256 JWT", () => {
    const jwt = createGitHubAppJwt(
      githubApp.appId,
      privateKeyPem,
      1_700_000_000_000,
    );
    const [encodedHeader, encodedPayload, encodedSignature] = jwt.split(".");

    expect(
      JSON.parse(Buffer.from(encodedHeader!, "base64url").toString()),
    ).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(
      JSON.parse(Buffer.from(encodedPayload!, "base64url").toString()),
    ).toEqual({
      iat: 1_699_999_940,
      exp: 1_700_000_540,
      iss: githubApp.appId,
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        publicKey,
        Buffer.from(encodedSignature!, "base64url"),
      ),
    ).toBe(true);
  });

  it("reads the key on demand and exchanges the JWT for an installation token", async () => {
    const readPrivateKey = vi.fn().mockResolvedValue(privateKeyPem);
    const request = vi
      .fn()
      .mockResolvedValue(
        tokenResponse("installation-token", "2023-11-14T23:00:00Z"),
      );
    const authenticator = new GitHubAppAuthenticator({
      readPrivateKey,
      request,
      now: () => 1_700_000_000_000,
    });

    await expect(
      authenticator.getInstallationToken(githubApp, repository),
    ).resolves.toBe("installation-token");
    expect(readPrivateKey).toHaveBeenCalledWith(githubApp.privateKeyPath);
    expect(request).toHaveBeenCalledWith(
      "https://api.github.com/app/installations/987654/access_tokens",
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: expect.stringMatching(/^Bearer\s+\S+$/),
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ repositories: ["repository"] }),
      },
    );
  });

  it("reuses an installation token before its refresh window", async () => {
    let nowMilliseconds = 1_700_000_000_000;
    const request = vi
      .fn()
      .mockResolvedValue(
        tokenResponse("installation-token", "2023-11-14T23:00:00Z"),
      );
    const authenticator = new GitHubAppAuthenticator({
      readPrivateKey: vi.fn().mockResolvedValue(privateKeyPem),
      request,
      now: () => nowMilliseconds,
    });

    await expect(
      authenticator.getInstallationToken(githubApp, repository),
    ).resolves.toBe("installation-token");
    nowMilliseconds += 30 * 60 * 1_000;
    await expect(
      authenticator.getInstallationToken(githubApp, repository),
    ).resolves.toBe("installation-token");

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("refreshes an installation token at the five-minute boundary", async () => {
    let nowMilliseconds = 1_700_000_000_000;
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        tokenResponse("old-installation-token", "2023-11-14T23:00:00Z"),
      )
      .mockResolvedValueOnce(
        tokenResponse("new-installation-token", "2023-11-15T00:00:00Z"),
      );
    const authenticator = new GitHubAppAuthenticator({
      readPrivateKey: vi.fn().mockResolvedValue(privateKeyPem),
      request,
      now: () => nowMilliseconds,
    });

    await expect(
      authenticator.getInstallationToken(githubApp, repository),
    ).resolves.toBe("old-installation-token");
    nowMilliseconds = Date.parse("2023-11-14T22:55:00Z");
    await expect(
      authenticator.getInstallationToken(githubApp, repository),
    ).resolves.toBe("new-installation-token");

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("replaces an expired installation token after a successful exchange", async () => {
    let nowMilliseconds = Date.parse("2023-11-14T22:00:00Z");
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        tokenResponse("expired-installation-token", "2023-11-14T22:30:00Z"),
      )
      .mockResolvedValueOnce(
        tokenResponse("replacement-installation-token", "2023-11-15T00:00:00Z"),
      );
    const authenticator = new GitHubAppAuthenticator({
      readPrivateKey: vi.fn().mockResolvedValue(privateKeyPem),
      request,
      now: () => nowMilliseconds,
    });

    await expect(
      authenticator.getInstallationToken(githubApp, repository),
    ).resolves.toBe("expired-installation-token");
    nowMilliseconds = Date.parse("2023-11-14T22:31:00Z");
    await expect(
      authenticator.getInstallationToken(githubApp, repository),
    ).resolves.toBe("replacement-installation-token");

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps installation tokens separate for different App identities", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        tokenResponse("app-a-token", "2023-11-14T23:00:00Z"),
      )
      .mockResolvedValueOnce(
        tokenResponse("app-b-token", "2023-11-14T23:00:00Z"),
      );
    const authenticator = new GitHubAppAuthenticator({
      readPrivateKey: vi.fn().mockResolvedValue(privateKeyPem),
      request,
      now: () => 1_700_000_000_000,
    });

    await expect(
      authenticator.getInstallationToken(githubApp, repository),
    ).resolves.toBe("app-a-token");
    await expect(
      authenticator.getInstallationToken(
        {
          ...githubApp,
          appId: "654321",
        },
        repository,
      ),
    ).resolves.toBe("app-b-token");

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps installation tokens separate for different repository scopes", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        tokenResponse("repository-a-token", "2023-11-14T23:00:00Z"),
      )
      .mockResolvedValueOnce(
        tokenResponse("repository-b-token", "2023-11-14T23:00:00Z"),
      );
    const authenticator = new GitHubAppAuthenticator({
      readPrivateKey: vi.fn().mockResolvedValue(privateKeyPem),
      request,
      now: () => 1_700_000_000_000,
    });

    await expect(
      authenticator.getInstallationToken(githubApp, "owner/repository-a"),
    ).resolves.toBe("repository-a-token");
    await expect(
      authenticator.getInstallationToken(githubApp, "owner/repository-b"),
    ).resolves.toBe("repository-b-token");
    await expect(
      authenticator.getInstallationToken(githubApp, "owner/repository-a"),
    ).resolves.toBe("repository-a-token");

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ repositories: ["repository-a"] }),
    );
    expect(request.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ repositories: ["repository-b"] }),
    );
  });

  it("does not share in-flight exchanges across repository scopes", async () => {
    let resolveFirst: ((value: Response) => void) | undefined;
    const request = vi.fn((input: string, init: RequestInit) => {
      if (init.body === JSON.stringify({ repositories: ["repository-a"] })) {
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      }

      return Promise.resolve(
        tokenResponse("repository-b-token", "2023-11-14T23:00:00Z"),
      );
    });
    const authenticator = new GitHubAppAuthenticator({
      readPrivateKey: vi.fn().mockResolvedValue(privateKeyPem),
      request,
      now: () => 1_700_000_000_000,
    });

    const first = authenticator.getInstallationToken(
      githubApp,
      "owner/repository-a",
    );
    await expect(
      authenticator.getInstallationToken(githubApp, "owner/repository-b"),
    ).resolves.toBe("repository-b-token");

    resolveFirst?.(tokenResponse("repository-a-token", "2023-11-14T23:00:00Z"));
    await expect(first).resolves.toBe("repository-a-token");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not cache or broaden a rejected repository-scoped exchange", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response({ message: "Not Found" }, 404))
      .mockResolvedValueOnce(
        tokenResponse("replacement-token", "2023-11-14T23:00:00Z"),
      );
    const authenticator = new GitHubAppAuthenticator({
      readPrivateKey: vi.fn().mockResolvedValue(privateKeyPem),
      request,
      now: () => 1_700_000_000_000,
    });

    await expect(
      authenticator.getInstallationToken(githubApp, repository),
    ).rejects.toMatchObject({ name: "GitHubAppApiError", status: 404 });
    await expect(
      authenticator.getInstallationToken(githubApp, repository),
    ).resolves.toBe("replacement-token");
    expect(request).toHaveBeenCalledTimes(2);
    expect(
      request.mock.calls.every((call) => call[1]?.body !== undefined),
    ).toBe(true);
  });

  it("does not cache a response with an invalid expiration", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        response({ token: "uncacheable-token", expires_at: "invalid" }),
      )
      .mockResolvedValueOnce(
        tokenResponse("replacement-token", "2023-11-14T23:00:00Z"),
      );
    const authenticator = new GitHubAppAuthenticator({
      readPrivateKey: vi.fn().mockResolvedValue(privateKeyPem),
      request,
      now: () => 1_700_000_000_000,
    });

    await expect(
      authenticator.getInstallationToken(githubApp, repository),
    ).rejects.toBeInstanceOf(GitHubAppApiError);
    await expect(
      authenticator.getInstallationToken(githubApp, repository),
    ).resolves.toBe("replacement-token");

    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an already expired expiration", -1],
    ["an expiration inside the refresh window", 5 * 60 * 1_000 - 1],
    ["an expiration at the refresh-window boundary", 5 * 60 * 1_000],
  ])(
    "rejects %s without caching the unusable token",
    async (_label, offsetMilliseconds) => {
      const nowMilliseconds = 1_700_000_000_000;
      const unusableExpiration = new Date(
        nowMilliseconds + offsetMilliseconds,
      ).toISOString();
      const replacementExpiration = new Date(
        nowMilliseconds + 10 * 60 * 1_000,
      ).toISOString();
      const request = vi
        .fn()
        .mockResolvedValueOnce(
          tokenResponse("unusable-installation-token", unusableExpiration),
        )
        .mockResolvedValueOnce(
          tokenResponse(
            "replacement-installation-token",
            replacementExpiration,
          ),
        );
      const authenticator = new GitHubAppAuthenticator({
        readPrivateKey: vi.fn().mockResolvedValue(privateKeyPem),
        request,
        now: () => nowMilliseconds,
      });

      const error = await authenticator
        .getInstallationToken(githubApp, repository)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(GitHubAppApiError);
      expect(error).toMatchObject({
        name: "GitHubAppApiError",
        operation: "installation token exchange",
      });
      expect(error).not.toHaveProperty(
        "message",
        expect.stringContaining("unusable-installation-token"),
      );
      expect(error).not.toHaveProperty(
        "message",
        expect.stringContaining(unusableExpiration),
      );

      await expect(
        authenticator.getInstallationToken(githubApp, repository),
      ).resolves.toBe("replacement-installation-token");
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it("caches and reuses an installation token beyond the refresh window", async () => {
    const nowMilliseconds = 1_700_000_000_000;
    const request = vi
      .fn()
      .mockResolvedValue(
        tokenResponse(
          "usable-installation-token",
          new Date(nowMilliseconds + 10 * 60 * 1_000).toISOString(),
        ),
      );
    const authenticator = new GitHubAppAuthenticator({
      readPrivateKey: vi.fn().mockResolvedValue(privateKeyPem),
      request,
      now: () => nowMilliseconds,
    });

    await expect(
      authenticator.getInstallationToken(githubApp, repository),
    ).resolves.toBe("usable-installation-token");
    await expect(
      authenticator.getInstallationToken(githubApp, repository),
    ).resolves.toBe("usable-installation-token");

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not read a key until token generation is requested", () => {
    const readPrivateKey = vi.fn().mockResolvedValue(privateKeyPem);

    new GitHubAppAuthenticator({ readPrivateKey });

    expect(readPrivateKey).not.toHaveBeenCalled();
  });

  it("classifies missing configuration without exposing credential values", async () => {
    const secret = "private-key-content";
    const authenticator = new GitHubAppAuthenticator({
      readPrivateKey: vi.fn().mockResolvedValue(secret),
    });

    await expect(
      authenticator.getInstallationToken(undefined, repository),
    ).rejects.toBeInstanceOf(GitHubAppConfigurationError);
    await expect(
      authenticator.getInstallationToken(undefined, repository),
    ).rejects.not.toThrow(secret);
  });

  it("rejects an absent repository scope without making an unrestricted request", async () => {
    const request = vi.fn();
    const authenticator = new GitHubAppAuthenticator({
      readPrivateKey: vi.fn().mockResolvedValue(privateKeyPem),
      request,
    });

    await expect(
      authenticator.getInstallationToken(githubApp, undefined),
    ).rejects.toBeInstanceOf(GitHubAppConfigurationError);
    expect(request).not.toHaveBeenCalled();
  });

  it("classifies unreadable private keys without exposing the read failure", async () => {
    const secret = "private-key-content";
    const authenticator = new GitHubAppAuthenticator({
      readPrivateKey: vi.fn().mockRejectedValue(new Error(`failed: ${secret}`)),
    });

    const error = await authenticator
      .getInstallationToken(githubApp, repository)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubAppCredentialError);
    expect(error).toHaveProperty("operation", "private key read");
    expect(error).not.toHaveProperty(
      "message",
      expect.stringContaining(secret),
    );
  });

  it("classifies invalid private keys and signing failures separately from requests", async () => {
    const request = vi.fn();
    const authenticator = new GitHubAppAuthenticator({
      readPrivateKey: vi.fn().mockResolvedValue("not a PEM key"),
      request,
    });

    await expect(
      authenticator.getInstallationToken(githubApp, repository),
    ).rejects.toMatchObject({
      name: "GitHubAppCredentialError",
      operation: "JWT generation",
    });
    expect(request).not.toHaveBeenCalled();

    const signingFailure: SignGitHubAppJwt = () => {
      throw new Error("signing failed with private-key-content");
    };
    const signingAuthenticator = new GitHubAppAuthenticator({
      readPrivateKey: vi.fn().mockResolvedValue(privateKeyPem),
      signJwt: signingFailure,
      request,
    });

    await expect(
      signingAuthenticator.getInstallationToken(githubApp, repository),
    ).rejects.toMatchObject({
      name: "GitHubAppCredentialError",
      operation: "JWT generation",
    });
  });

  it("classifies request failures without exposing the JWT", async () => {
    const request = vi.fn().mockRejectedValue(new Error("network failed"));
    const authenticator = new GitHubAppAuthenticator({
      readPrivateKey: vi.fn().mockResolvedValue(privateKeyPem),
      request,
      now: () => 1_700_000_000_000,
    });

    const error = await authenticator
      .getInstallationToken(githubApp, repository)
      .catch((caught: unknown) => caught);
    const authorization = request.mock.calls[0]?.[1]?.headers;
    const jwt =
      authorization instanceof Headers
        ? authorization.get("Authorization")
        : (authorization as Record<string, string> | undefined)?.Authorization;

    expect(error).toBeInstanceOf(GitHubAppNetworkError);
    expect(error).not.toHaveProperty(
      "message",
      expect.stringContaining(jwt ?? ""),
    );
  });

  it("classifies HTTP failures without exposing the response body", async () => {
    const responseBody = "installation-token-response-secret";
    const authenticator = new GitHubAppAuthenticator({
      readPrivateKey: vi.fn().mockResolvedValue(privateKeyPem),
      request: vi
        .fn()
        .mockResolvedValue(response({ error: responseBody }, 401)),
    });

    const error = await authenticator
      .getInstallationToken(githubApp, repository)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubAppApiError);
    expect(error).toMatchObject({
      status: 401,
      operation: "installation token exchange",
    });
    expect(error).not.toHaveProperty(
      "message",
      expect.stringContaining(responseBody),
    );
  });

  it.each([
    ["malformed JSON", new Response("not json", { status: 201 })],
    ["missing token", response({ expires_at: "2023-11-14T23:00:00Z" })],
    [
      "blank token",
      response({ token: "  ", expires_at: "2023-11-14T23:00:00Z" }),
    ],
    [
      "non-string token",
      response({ token: 42, expires_at: "2023-11-14T23:00:00Z" }),
    ],
    ["missing expiration", response({ token: "installation-token" })],
    [
      "blank expiration",
      response({ token: "installation-token", expires_at: "  " }),
    ],
    [
      "invalid expiration",
      response({ token: "installation-token", expires_at: "later" }),
    ],
    [
      "non-string expiration",
      response({ token: "installation-token", expires_at: 42 }),
    ],
  ])(
    "rejects %s without exposing response data",
    async (_label, tokenResponse) => {
      const responseSecret = "response-body-secret";
      const authenticator = new GitHubAppAuthenticator({
        readPrivateKey: vi.fn().mockResolvedValue(privateKeyPem),
        request: vi.fn().mockResolvedValue(tokenResponse),
      });

      const error = await authenticator
        .getInstallationToken(githubApp, repository)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(GitHubAppApiError);
      expect(error).not.toHaveProperty(
        "message",
        expect.stringContaining(responseSecret),
      );
    },
  );
});
