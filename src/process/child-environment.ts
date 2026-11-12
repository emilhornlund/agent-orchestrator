import fs from "node:fs";
import path from "node:path";

/** Minimal inherited environment contract for each child-process family. */
export type ChildProcessFamily = "command" | "git" | "github" | "opencode" | "flock";

const platformKeys = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TMP",
  "TEMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
];

const gitKeys = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_TERMINAL_PROMPT",
  "GIT_ASKPASS",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
];

const openCodeProviderCredentials: Readonly<Record<string, readonly string[]>> = {
  openai: ["OPENAI_API_KEY", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  "google-vertex": [
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_VERTEX_PROJECT",
  ],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  groq: ["GROQ_API_KEY"],
  xai: ["XAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  "azure-openai": ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"],
  cohere: ["COHERE_API_KEY"],
  bedrock: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION"],
};

export function hasOpenCodeProviderCredentials(
  supplied: Readonly<Record<string, string | undefined>> = {},
  parent: Readonly<NodeJS.ProcessEnv> = process.env,
): boolean {
  return Object.values(openCodeProviderCredentials)
    .flat()
    .some((key) => supplied[key] !== undefined || parent[key] !== undefined);
}

export function providerFromModel(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  const separator = model.indexOf("/");
  return separator <= 0 ? undefined : model.slice(0, separator).toLowerCase();
}

function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    const next = input[index + 1];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
    } else if (character === "/" && next === "/") {
      while (index < input.length && input[index] !== "\n") index += 1;
      output += "\n";
    } else if (character === "/" && next === "*") {
      index += 2;
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) {
        output += input[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      index += 1;
    } else if (character === ",") {
      let lookahead = index + 1;
      while (lookahead < input.length) {
        while (/\s/u.test(input[lookahead] ?? "")) lookahead += 1;
        if (input[lookahead] === "/" && input[lookahead + 1] === "/") {
          while (lookahead < input.length && input[lookahead] !== "\n") lookahead += 1;
          continue;
        }
        if (input[lookahead] === "/" && input[lookahead + 1] === "*") {
          lookahead += 2;
          while (
            lookahead < input.length &&
            !(input[lookahead] === "*" && input[lookahead + 1] === "/")
          )
            lookahead += 1;
          if (lookahead < input.length) lookahead += 2;
          continue;
        }
        break;
      }
      if (input[lookahead] !== "}" && input[lookahead] !== "]") output += character;
    } else {
      output += character;
    }
  }
  return output;
}

/** Relative OpenCode config locations resolve from the CLI worktree, not here. */
export function openCodeDefaultConfigPathIssue(
  environment: Readonly<NodeJS.ProcessEnv>,
): string | undefined {
  for (const [name, value] of [
    ["OPENCODE_CONFIG", environment.OPENCODE_CONFIG],
    ["OPENCODE_CONFIG_DIR", environment.OPENCODE_CONFIG_DIR],
    ["XDG_CONFIG_HOME", environment.XDG_CONFIG_HOME],
  ] as const) {
    if (value !== undefined && !path.isAbsolute(value)) {
      return `${name} must be an absolute path when OpenCode model selection is delegated; relative paths resolve differently from the orchestrator and task worktree`;
    }
  }
  return undefined;
}

function modelFromConfig(configPath: string): string | undefined {
  try {
    const stat = fs.statSync(configPath);
    if (!stat.isFile() || stat.size > 1_048_576) return undefined;
    const parsed: unknown = JSON.parse(stripJsonComments(fs.readFileSync(configPath, "utf8")));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const model = Reflect.get(parsed, "model");
    return typeof model === "string" && model.trim().length > 0 ? model : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve only OpenCode's configured default provider; never select a model. */
export function providerForOpenCodeDefault(
  environment: Readonly<NodeJS.ProcessEnv>,
): string | undefined {
  const home = environment.HOME ?? environment.USERPROFILE;
  const customFile = environment.OPENCODE_CONFIG;
  const configDirectory = environment.OPENCODE_CONFIG_DIR;
  const xdgDirectory = environment.XDG_CONFIG_HOME;
  const userDirectory = home === undefined ? undefined : path.join(home, ".config");
  const roots = [
    ...(customFile === undefined ? [] : [customFile]),
    ...(configDirectory !== undefined
      ? [path.join(configDirectory, "opencode.json"), path.join(configDirectory, "opencode.jsonc")]
      : xdgDirectory !== undefined
        ? [
            path.join(xdgDirectory, "opencode", "opencode.json"),
            path.join(xdgDirectory, "opencode", "opencode.jsonc"),
          ]
        : userDirectory === undefined
          ? []
          : [
              path.join(userDirectory, "opencode", "opencode.json"),
              path.join(userDirectory, "opencode", "opencode.jsonc"),
            ]),
  ];
  // Read only operator-owned configuration paths, never project/worktree files.
  for (const file of roots) {
    const provider = providerFromModel(modelFromConfig(file));
    if (provider !== undefined) return provider;
  }
  return undefined;
}

export function buildChildEnvironment(
  family: ChildProcessFamily,
  supplied: Readonly<Record<string, string | undefined>> = {},
  parent: Readonly<NodeJS.ProcessEnv> = process.env,
  selectedProvider?: string,
): Record<string, string> {
  const keys = new Set(platformKeys);
  if (family === "git") for (const key of gitKeys) keys.add(key);
  if (family === "git") {
    // Git's HTTPS askpass bridge uses the project's scoped GitHub token.
    keys.add("GH_TOKEN");
    keys.add("GITHUB_TOKEN");
  }
  if (family === "github") {
    for (const key of [...gitKeys, "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST"]) keys.add(key);
  }
  if (family === "opencode") {
    for (const key of openCodeProviderCredentials[selectedProvider ?? ""] ?? []) keys.add(key);
    keys.add("XDG_CONFIG_HOME");
    keys.add("OPENCODE_CONFIG");
    keys.add("OPENCODE_CONFIG_DIR");
  }

  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = supplied[key] ?? parent[key];
    if (value !== undefined) result[key] = value;
  }
  // Explicitly supplied values are accepted only when they belong to this
  // operation's contract. This prevents broad environment bags becoming leaks.
  for (const [key, value] of Object.entries(supplied)) {
    if (value !== undefined && keys.has(key)) {
      result[key] = value;
    }
  }
  return result;
}
