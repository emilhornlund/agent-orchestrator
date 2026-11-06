import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** A disposable Git environment that excludes inherited Git and Node options. */
export function createIsolatedGitFixture(root: string): {
  env: NodeJS.ProcessEnv;
  git: (cwd: string, ...args: string[]) => string;
} {
  const home = path.join(root, "isolated-home");
  const template = path.join(root, "empty-template");
  const globalConfig = path.join(home, "gitconfig");
  const systemConfig = path.join(root, "empty-system-gitconfig");
  fs.mkdirSync(home);
  fs.mkdirSync(template);
  fs.writeFileSync(systemConfig, "");
  fs.writeFileSync(
    globalConfig,
    [
      "[user]",
      "\tname = Isolated fixture",
      "\temail = isolated@example.test",
      "[commit]",
      "\tgpgsign = false",
      "[core]",
      "\thooksPath = /dev/null",
      "[credential]",
      "\thelper =",
      "",
    ].join("\n"),
  );
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: home,
    TMPDIR: root,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: systemConfig,
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: template,
  };
  return {
    env,
    git(cwd, ...args) {
      return execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
    },
  };
}
