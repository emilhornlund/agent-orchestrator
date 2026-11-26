import { execFileSync, spawnSync } from "node:child_process";
import console from "node:console";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const local = path.join(root, ".local/container");
const service = "agent-orchestrator";
const commands = {
  down: ["stop", "-t", "120"],
  restart: ["restart", "-t", "120", service],
  logs: ["logs", "-f", service],
  shell: ["exec", service, "sh"],
  doctor: ["exec", "-T", service, "node", "dist/doctor.js"],
  status: ["ps"],
};

function setup() {
  fs.mkdirSync(local, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(path.join(local, "compose.yaml"))) {
    fs.mkdirSync(path.join(local, "secrets"), { recursive: true, mode: 0o700 });
  }
  for (const [name, content] of [
    ["config.yaml", fs.readFileSync(path.join(root, "containers/local-config.example.yaml"))],
    ["stack.env", "TRELLO_API_KEY=\nTRELLO_TOKEN=\nGH_TOKEN=\n"],
  ]) {
    try {
      fs.writeFileSync(path.join(local, name), content, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
}

function compose(command, args) {
  const engine =
    process.env.LOCAL_ENGINE ||
    (spawnSync("docker", ["--version"]).error?.code === "ENOENT" ? "podman" : "docker");
  const privateFile = path.join(local, "compose.yaml");
  const custom = fs.existsSync(privateFile);
  const files = ["-f", custom ? privateFile : "compose.local.yaml"];
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 12);
  const project = `orchestrator-local-${hash}${custom ? "-private" : ""}`;
  const env = {
    ...process.env,
    LOCAL_IMAGE: `localhost/${project}:dev`,
    // Podman Compose does not replace a service just because its image was rebuilt.
    LOCAL_REBUILD: String(Date.now()),
  };
  const inspect = (...args) => execFileSync(engine, args, { cwd: root, encoding: "utf8" }).trim();
  if (engine === "podman") {
    if (env.CONTAINER_HOST || env.CONTAINER_CONNECTION) throw new Error("Use local Podman");
    env.PODMAN_COMPOSE_PROVIDER = "podman-compose";
    if (!custom && inspect("info", "--format", "{{.Host.Security.SELinuxEnabled}}") === "true") {
      files.push("-f", "containers/local-selinux.yaml");
    }
  } else if (engine === "docker") {
    const endpoint = inspect("context", "inspect", "--format", "{{.Endpoints.docker.Host}}");
    if (
      !endpoint.startsWith("unix://") ||
      env.DOCKER_HOST ||
      env.BUILDX_BUILDER ||
      env.BUILDKIT_HOST
    ) {
      throw new Error("Use a local Docker context and unset Docker endpoint or builder overrides");
    }
  } else throw new Error("LOCAL_ENGINE must be docker or podman");

  const result = spawnSync(
    engine,
    ["compose", "--env-file", "/dev/null", "-p", project, ...files, ...args],
    { cwd: root, env, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (exit ${result.status})`);
}

const command = process.argv[2];
try {
  if (command === "setup" || command === "up") setup();
  if (command === "up") {
    const file = path.join(local, "stack.env");
    const info = fs.lstatSync(file);
    if (!info.isFile() || (info.mode & 0o077) !== 0) {
      throw new Error("Use a private .local/container/stack.env file (chmod 600)");
    }
    const credentials = fs.readFileSync(file, "utf8");
    if (
      !["TRELLO_API_KEY", "TRELLO_TOKEN"].every((key) =>
        new RegExp(`^${key}=[^\\s]`, "m").test(credentials),
      )
    ) {
      throw new Error(
        "Fill in .local/container/stack.env and config.yaml, then rerun yarn local up",
      );
    }
    compose(command, ["up", "-d", "--build", service]);
  } else if (command === "setup") {
    console.log("Local files are in .local/container/");
  } else if (Object.hasOwn(commands, command)) {
    compose(command, commands[command]);
  } else {
    console.log("Usage: yarn local up | logs | status | shell | doctor | restart | down");
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(`Local container: ${error.message}`);
  process.exitCode = 1;
}
