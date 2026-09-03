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

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const privateKeyPem = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

function response(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), { status });
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
      .mockResolvedValue(response({ token: "installation-token" }));
    const authenticator = new GitHubAppAuthenticator({
      readPrivateKey,
      request,
      now: () => 1_700_000_000_000,
    });

    await expect(authenticator.getInstallationToken(githubApp)).resolves.toBe(
      "installation-token",
    );
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
      },
    );
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
      authenticator.getInstallationToken(undefined),
    ).rejects.toBeInstanceOf(GitHubAppConfigurationError);
    await expect(
      authenticator.getInstallationToken(undefined),
    ).rejects.not.toThrow(secret);
  });

  it("classifies unreadable private keys without exposing the read failure", async () => {
    const secret = "private-key-content";
    const authenticator = new GitHubAppAuthenticator({
      readPrivateKey: vi.fn().mockRejectedValue(new Error(`failed: ${secret}`)),
    });

    const error = await authenticator
      .getInstallationToken(githubApp)
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
      authenticator.getInstallationToken(githubApp),
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
      signingAuthenticator.getInstallationToken(githubApp),
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
      .getInstallationToken(githubApp)
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
      .getInstallationToken(githubApp)
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
    ["missing token", response({ expires_at: "later" })],
    ["blank token", response({ token: "  " })],
    ["non-string token", response({ token: 42 })],
  ])(
    "rejects %s without exposing response data",
    async (_label, tokenResponse) => {
      const responseSecret = "response-body-secret";
      const authenticator = new GitHubAppAuthenticator({
        readPrivateKey: vi.fn().mockResolvedValue(privateKeyPem),
        request: vi.fn().mockResolvedValue(tokenResponse),
      });

      const error = await authenticator
        .getInstallationToken(githubApp)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(GitHubAppApiError);
      expect(error).not.toHaveProperty(
        "message",
        expect.stringContaining(responseSecret),
      );
    },
  );
});
