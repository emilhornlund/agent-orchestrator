import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildChildEnvironment,
  openCodeDefaultConfigPathIssue,
  providerForOpenCodeDefault,
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
