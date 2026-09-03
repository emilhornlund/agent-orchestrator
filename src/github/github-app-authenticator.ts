import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { GitHubAppConfig } from "../config/config.js";

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const JWT_LIFETIME_SECONDS = 9 * 60;
const JWT_ISSUED_AT_OFFSET_SECONDS = 60;
const INSTALLATION_TOKEN_REFRESH_WINDOW_MILLISECONDS = 5 * 60 * 1_000;

export type GitHubAppOperation =
  | "configuration"
  | "private key read"
  | "JWT generation"
  | "installation token exchange";

export class GitHubAppConfigurationError extends Error {
  readonly operation: GitHubAppOperation = "configuration";

  constructor() {
    super("GitHub App configuration is invalid or missing");
    this.name = "GitHubAppConfigurationError";
  }
}

export class GitHubAppCredentialError extends Error {
  readonly operation: "private key read" | "JWT generation";

  constructor(operation: "private key read" | "JWT generation") {
    super(`GitHub App ${operation} failed`);
    this.name = "GitHubAppCredentialError";
    this.operation = operation;
  }
}

export class GitHubAppNetworkError extends Error {
  readonly operation = "installation token exchange" as const;

  constructor() {
    super(
      "GitHub App installation token exchange failed during the network request",
    );
    this.name = "GitHubAppNetworkError";
  }
}

export class GitHubAppApiError extends Error {
  readonly operation = "installation token exchange" as const;
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "GitHubAppApiError";
    this.status = status;
  }
}

export type ReadGitHubAppPrivateKey = (
  privateKeyPath: string,
) => Promise<string>;
export type SignGitHubAppJwt = (
  signingInput: string,
  privateKey: ReturnType<typeof createPrivateKey>,
) => Buffer;
export type RequestGitHubAppToken = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface GitHubAppAuthenticatorOptions {
  readPrivateKey?: ReadGitHubAppPrivateKey;
  signJwt?: SignGitHubAppJwt;
  request?: RequestGitHubAppToken;
  now?: () => number;
}

function encodeBase64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function validateGithubAppConfig(
  githubApp: GitHubAppConfig | undefined,
): asserts githubApp is GitHubAppConfig {
  if (
    githubApp === undefined ||
    typeof githubApp.appId !== "string" ||
    githubApp.appId.trim().length === 0 ||
    typeof githubApp.installationId !== "string" ||
    githubApp.installationId.trim().length === 0 ||
    typeof githubApp.privateKeyPath !== "string" ||
    githubApp.privateKeyPath.trim().length === 0 ||
    !path.isAbsolute(githubApp.privateKeyPath)
  ) {
    throw new GitHubAppConfigurationError();
  }
}

function defaultSignJwt(
  signingInput: string,
  privateKey: ReturnType<typeof createPrivateKey>,
): Buffer {
  return sign("RSA-SHA256", Buffer.from(signingInput), privateKey);
}

export function createGitHubAppJwt(
  appId: string,
  privateKeyPem: string,
  nowMilliseconds = Date.now(),
  signJwt: SignGitHubAppJwt = defaultSignJwt,
): string {
  const nowSeconds = Math.floor(nowMilliseconds / 1_000);

  if (!Number.isSafeInteger(nowSeconds)) {
    throw new Error("Invalid JWT timestamp");
  }

  const header = encodeBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = encodeBase64Url(
    JSON.stringify({
      iat: nowSeconds - JWT_ISSUED_AT_OFFSET_SECONDS,
      exp: nowSeconds + JWT_LIFETIME_SECONDS,
      iss: appId,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const privateKey = createPrivateKey({
    key: privateKeyPem,
    format: "pem",
  });
  const signature = signJwt(signingInput, privateKey);

  return `${signingInput}.${signature.toString("base64url")}`;
}

interface CachedInstallationToken {
  readonly token: string;
  readonly expiresAtMilliseconds: number;
}

interface InstallationTokenResponse {
  readonly token: string;
  readonly expiresAtMilliseconds: number;
}

function parseTokenResponse(
  value: unknown,
): InstallationTokenResponse | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("token" in value) ||
    typeof value.token !== "string" ||
    value.token.trim().length === 0 ||
    !("expires_at" in value) ||
    typeof value.expires_at !== "string" ||
    value.expires_at.trim().length === 0
  ) {
    return undefined;
  }

  const expiresAtMilliseconds = Date.parse(value.expires_at);

  if (!Number.isFinite(expiresAtMilliseconds)) {
    return undefined;
  }

  return {
    token: value.token,
    expiresAtMilliseconds,
  };
}

const defaultRequest: RequestGitHubAppToken = (input, init) =>
  globalThis.fetch(input, init);

export class GitHubAppAuthenticator {
  private readonly readPrivateKey: ReadGitHubAppPrivateKey;
  private readonly signJwt: SignGitHubAppJwt;
  private readonly request: RequestGitHubAppToken;
  private readonly now: () => number;
  private readonly installationTokens = new Map<
    string,
    CachedInstallationToken
  >();
  private readonly pendingExchanges = new Map<string, Promise<string>>();

  constructor(options: GitHubAppAuthenticatorOptions = {}) {
    this.readPrivateKey =
      options.readPrivateKey ??
      ((privateKeyPath) => readFile(privateKeyPath, "utf8"));
    this.signJwt = options.signJwt ?? defaultSignJwt;
    this.request = options.request ?? defaultRequest;
    this.now = options.now ?? Date.now;
  }

  async getInstallationToken(
    githubApp: GitHubAppConfig | undefined,
  ): Promise<string> {
    validateGithubAppConfig(githubApp);

    const cacheKey = JSON.stringify([
      githubApp.appId,
      githubApp.installationId,
      githubApp.privateKeyPath,
    ]);
    const nowMilliseconds = this.now();
    const cachedToken = this.installationTokens.get(cacheKey);

    if (
      cachedToken !== undefined &&
      nowMilliseconds <
        cachedToken.expiresAtMilliseconds -
          INSTALLATION_TOKEN_REFRESH_WINDOW_MILLISECONDS
    ) {
      return cachedToken.token;
    }

    const pendingExchange = this.pendingExchanges.get(cacheKey);

    if (pendingExchange !== undefined) {
      return pendingExchange;
    }

    const exchange = this.exchangeInstallationToken(
      githubApp,
      nowMilliseconds,
      cacheKey,
    );
    this.pendingExchanges.set(cacheKey, exchange);

    try {
      return await exchange;
    } finally {
      this.pendingExchanges.delete(cacheKey);
    }
  }

  private async exchangeInstallationToken(
    githubApp: GitHubAppConfig,
    nowMilliseconds: number,
    cacheKey: string,
  ): Promise<string> {
    let privateKeyPem: string;

    try {
      privateKeyPem = await this.readPrivateKey(githubApp.privateKeyPath);
    } catch {
      throw new GitHubAppCredentialError("private key read");
    }

    let jwt: string;

    try {
      jwt = createGitHubAppJwt(
        githubApp.appId,
        privateKeyPem,
        nowMilliseconds,
        this.signJwt,
      );
    } catch {
      throw new GitHubAppCredentialError("JWT generation");
    }

    const endpoint = `${GITHUB_API_URL}/app/installations/${encodeURIComponent(githubApp.installationId)}/access_tokens`;
    let response: Response;

    try {
      response = await this.request(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${jwt}`,
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
      });
    } catch {
      throw new GitHubAppNetworkError();
    }

    if (!response.ok) {
      throw new GitHubAppApiError(
        `GitHub App installation token exchange failed with HTTP ${response.status}`,
        response.status,
      );
    }

    let body: unknown;

    try {
      body = await response.json();
    } catch {
      throw new GitHubAppApiError(
        "GitHub App installation token exchange returned invalid JSON",
        response.status,
      );
    }

    const tokenResponse = parseTokenResponse(body);

    if (tokenResponse === undefined) {
      throw new GitHubAppApiError(
        "GitHub App installation token exchange returned an invalid token response",
        response.status,
      );
    }

    this.installationTokens.set(cacheKey, {
      token: tokenResponse.token,
      expiresAtMilliseconds: tokenResponse.expiresAtMilliseconds,
    });

    return tokenResponse.token;
  }
}
