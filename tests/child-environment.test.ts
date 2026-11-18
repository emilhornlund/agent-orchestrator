import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildChildEnvironment,
  openCodeDefaultConfigPathIssue,
  providerForOpenCodeDefault,
  resolveTaskEnvironment,
  taskEnvironmentSecretValues,
} from "../src/process/child-environment.js";

describe("child process environment manifests", () => {
  const parent = {
    PATH: "/tools",
    HOME: "/home/user",
    SYSTEMROOT: "/windows",
    GH_TOKEN: "ambient-pat",
    GITHUB_TOKEN: "ambient-pat-2",
    OPENAI_API_KEY: "provider-key",
    ANTHROPIC_API_KEY: "other-provider",
    TRELLO_API_KEY: "trello-secret",
    SMTP_PASSWORD: "mail-secret",
    DATABASE_URL: "unrelated-secret",
    GIT_AUTHOR_NAME: "Agent",
  };

  it.each([
    ["command", ["PATH", "HOME", "SYSTEMROOT"]],
    ["flock", ["PATH", "HOME", "SYSTEMROOT"]],
    ["git", ["PATH", "HOME", "SYSTEMROOT", "GIT_AUTHOR_NAME", "GH_TOKEN", "GITHUB_TOKEN"]],
    ["github", ["PATH", "HOME", "SYSTEMROOT", "GIT_AUTHOR_NAME", "GH_TOKEN", "GITHUB_TOKEN"]],
    ["opencode", ["PATH", "HOME", "SYSTEMROOT"]],
  ] as const)("allows only the %s process manifest", (family, expected) => {
    const actual = buildChildEnvironment(family, {}, parent);
    expect(Object.keys(actual).sort()).toEqual([...expected].sort());
    expect(actual).not.toHaveProperty("TRELLO_API_KEY");
    expect(actual).not.toHaveProperty("SMTP_PASSWORD");
    expect(actual).not.toHaveProperty("DATABASE_URL");
  });

  it("does not forward explicitly supplied unrelated credentials", () => {
    expect(
      buildChildEnvironment(
        "command",
        {
          TRELLO_API_KEY: "secret",
          CUSTOM_VALUE: "also-secret",
          PATH: "/custom",
        },
        parent,
      ),
    ).toEqual({ PATH: "/custom", HOME: "/home/user", SYSTEMROOT: "/windows" });
  });

  it.each(["command", "opencode"] as const)(
    "forwards only the project's mapped application settings to %s",
    (family) => {
      const environment = {
        ...parent,
        PROJECT_A_REDIS_HOST: "test-redis-a",
        PROJECT_B_REDIS_HOST: "test-redis-b",
        APP_EMPTY: "",
      };
      const result = buildChildEnvironment(
        family,
        { REDIS_HOST: "untrusted-override" },
        environment,
        undefined,
        {
          REDIS_HOST: "PROJECT_A_REDIS_HOST",
          APP_EMPTY: "APP_EMPTY",
        },
      );
      expect(result).toMatchObject({
        REDIS_HOST: "test-redis-a",
        APP_EMPTY: "",
      });
      const other = buildChildEnvironment(family, {}, environment, undefined, {
        REDIS_HOST: "PROJECT_B_REDIS_HOST",
      });
      expect(other.REDIS_HOST).toBe("test-redis-b");
      expect(other).not.toHaveProperty("APP_EMPTY");
      expect(buildChildEnvironment(family, {}, environment)).not.toHaveProperty("REDIS_HOST");
      expect(result).not.toHaveProperty("PROJECT_A_REDIS_HOST");
      expect(result).not.toHaveProperty("PROJECT_B_REDIS_HOST");
      expect(result).not.toHaveProperty("TRELLO_API_KEY");
      expect(result).not.toHaveProperty("SMTP_PASSWORD");
      expect(result).not.toHaveProperty("DATABASE_URL");
    },
  );

  it.each(["git", "github", "flock"] as const)(
    "keeps task settings out of %s operations",
    (family) => {
      expect(
        buildChildEnvironment(
          family,
          {},
          {
            ...parent,
            REDIS_HOST: "test-redis",
          },
          undefined,
          { REDIS_HOST: "REDIS_HOST" },
        ),
      ).not.toHaveProperty("REDIS_HOST");
    },
  );

  it("does not let task overrides widen project mappings", () => {
    expect(
      buildChildEnvironment(
        "command",
        {
          DATABASE_URL: "unrelated-secret",
        },
        parent,
      ),
    ).not.toHaveProperty("DATABASE_URL");
  });

  it.each([
    "*",
    "",
    "not-a-name",
    "TRELLO_TOKEN",
    "SMTP_PASSWORD",
    "GH_TOKEN",
    "GIT_CONFIG_COUNT",
    "OPENAI_API_KEY",
    "NODE_OPTIONS",
    "PATH",
    "OPENCODE_CONFIG_CONTENT",
    "__proto__",
  ])("rejects malformed or reserved task variable %s as either source or target", (key) => {
    expect(() => resolveTaskEnvironment({ [key]: "VALUE" }, { VALUE: "secret-value" })).toThrow(
      "invalid or reserved variable name",
    );
    expect(() => resolveTaskEnvironment({ VALUE: key }, { [key]: "secret-value" })).toThrow(
      "invalid or reserved variable name",
    );
  });

  it("rejects missing mapped sources and accepts unconfigured or empty mappings", () => {
    expect(() => resolveTaskEnvironment({ REDIS_HOST: "PROJECT_REDIS_HOST" }, {})).toThrow(
      "Task environment variable PROJECT_REDIS_HOST is not defined",
    );
    expect(resolveTaskEnvironment(undefined, parent)).toEqual({});
    expect(resolveTaskEnvironment({}, parent)).toEqual({});
  });

  it("registers task credentials and connection URLs by source or target without treating ports as secrets", () => {
    expect(
      taskEnvironmentSecretValues(
        {
          DATABASE_URL: "PROJECT_DATABASE",
          MONGODB_URI: "PROJECT_MONGO",
          APP_VALUE: "PROJECT_SECRET",
          REDIS_PORT: "REDIS_PORT",
        },
        {
          PROJECT_DATABASE: "mongodb://user:pass@db",
          PROJECT_MONGO: "mongodb://user:pass@mongo/test",
          PROJECT_SECRET: "task-secret",
          REDIS_PORT: "6379",
        },
      ),
    ).toEqual(["mongodb://user:pass@db", "mongodb://user:pass@mongo/test", "task-secret"]);
  });

  it("supports lowercase proxy settings without weakening reserved-name checks", () => {
    expect(
      resolveTaskEnvironment(
        { https_proxy: "PROJECT_PROXY" },
        { PROJECT_PROXY: "http://proxy:8080" },
      ),
    ).toEqual({ https_proxy: "http://proxy:8080" });
    expect(() =>
      resolveTaskEnvironment({ node_options: "APP_VALUE" }, { APP_VALUE: "unsafe" }),
    ).toThrow("reserved variable name");
    expect(resolveTaskEnvironment({ NODE_ENV: "PROJECT_MODE" }, { PROJECT_MODE: "test" })).toEqual({
      NODE_ENV: "test",
    });
  });

  it("rejects ambient and supplied GIT_CONFIG injection variables", () => {
    const hostileGitConfig = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "commit.gpgSign",
      GIT_CONFIG_VALUE_0: "false",
    };
    expect(
      buildChildEnvironment("git", hostileGitConfig, {
        ...parent,
        ...hostileGitConfig,
      }),
    ).not.toMatchObject(hostileGitConfig);
  });

  it("isolates project-scoped github credentials", () => {
    const projectA = buildChildEnvironment("github", { GH_TOKEN: "app-A" }, parent);
    const projectB = buildChildEnvironment("github", { GH_TOKEN: "pat-B" }, parent);
    expect(projectA.GH_TOKEN).toBe("app-A");
    expect(projectB.GH_TOKEN).toBe("pat-B");
    expect(projectA.GH_TOKEN).not.toBe(projectB.GH_TOKEN);
  });

  it("forwards only the explicitly selected OpenCode provider credentials", () => {
    const openai = buildChildEnvironment("opencode", {}, parent, "openai");
    const anthropic = buildChildEnvironment("opencode", {}, parent, "anthropic");
    const unknown = buildChildEnvironment("opencode", {}, parent, "unknown");
    expect(openai.OPENAI_API_KEY).toBe("provider-key");
    expect(openai).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(anthropic.ANTHROPIC_API_KEY).toBe("other-provider");
    expect(anthropic).not.toHaveProperty("OPENAI_API_KEY");
    expect(unknown).not.toHaveProperty("OPENAI_API_KEY");
    expect(unknown).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("uses XDG config instead of stale HOME config and handles JSONC comments around trailing commas", () => {
    const root = os.tmpdir();
    const fixture = fs.mkdtempSync(path.join(root, "opencode-config-scope-"));
    try {
      const xdg = path.join(fixture, "xdg");
      const home = path.join(fixture, "home");
      const xdgConfig = path.join(xdg, "opencode", "opencode.jsonc");
      const homeConfig = path.join(home, ".config", "opencode", "opencode.json");
      fs.mkdirSync(path.dirname(xdgConfig), { recursive: true });
      fs.mkdirSync(path.dirname(homeConfig), { recursive: true });
      fs.writeFileSync(
        xdgConfig,
        '{\n "model": "anthropic/selected", // comment after comma\n /* close */\n}',
      );
      fs.writeFileSync(homeConfig, '{"model":"openai/stale"}');
      expect(providerForOpenCodeDefault({ HOME: home, XDG_CONFIG_HOME: xdg })).toBe("anthropic");
      fs.writeFileSync(xdgConfig, '{ "other": [1, /* before close */], }');
      expect(providerForOpenCodeDefault({ HOME: home, XDG_CONFIG_HOME: xdg })).toBeUndefined();
      expect(providerForOpenCodeDefault({ HOME: home })).toBe("openai");
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects relative operator config roots instead of resolving against differing working directories", () => {
    expect(openCodeDefaultConfigPathIssue({ OPENCODE_CONFIG: "config.json" })).toContain(
      "OPENCODE_CONFIG must be an absolute path",
    );
    expect(openCodeDefaultConfigPathIssue({ OPENCODE_CONFIG_DIR: "config-dir" })).toContain(
      "OPENCODE_CONFIG_DIR must be an absolute path",
    );
    expect(openCodeDefaultConfigPathIssue({ XDG_CONFIG_HOME: "xdg" })).toContain(
      "XDG_CONFIG_HOME must be an absolute path",
    );
    expect(
      openCodeDefaultConfigPathIssue({ OPENCODE_CONFIG: "/etc/opencode.json" }),
    ).toBeUndefined();
  });
});
