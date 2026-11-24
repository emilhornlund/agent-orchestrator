import fs from "node:fs";
import path from "node:path";
import { runTaskResources } from "../task-session/task-resources.js";
import type { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { processSupervisorPath } from "../process/contained-process.js";

/** Mount only execution dependencies and the owned worktree, never the host root.
 * Git metadata stays read-only: commits and refs belong to the orchestrator. */
export function isolatedOpenCodeDispatch(
  authority: ProjectRunAuthority,
  cwd: string,
  environment: Record<string, string>,
  arguments_: string[],
  refinementResultDirectory?: string,
): { command: string; args: string[] } {
  if (process.platform !== "linux")
    throw new Error("Isolated OpenCode execution requires Linux Bubblewrap");
  const run = authority.store.assertCurrentLease(authority.ownerGeneration);
  const expected = runTaskResources(run).path;
  if (cwd !== expected || fs.realpathSync(cwd) !== expected)
    throw new Error("OpenCode dispatch does not match the owned task worktree");
  const gitFile = path.join(cwd, ".git");
  if (!fs.lstatSync(gitFile).isFile())
    throw new Error("OpenCode requires an owned linked worktree");
  const gitDirectory = fs.readFileSync(gitFile, "utf8").trim();
  if (!gitDirectory.startsWith("gitdir: ")) throw new Error("Invalid task worktree Git identity");
  const metadata = fs.realpathSync(path.resolve(cwd, gitDirectory.slice(8)));
  const common = fs.realpathSync(
    path.resolve(metadata, fs.readFileSync(path.join(metadata, "commondir"), "utf8").trim()),
  );
  if (
    common !== fs.realpathSync(path.join(run.pinned.repositoryPath, ".git")) ||
    fs.readFileSync(path.join(metadata, "gitdir"), "utf8").trim() !== gitFile
  )
    throw new Error("OpenCode worktree metadata does not match its source repository");
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--as-pid-1",
    "--unshare-ipc",
    "--unshare-uts",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/tmp/opencode",
    // Keep the original checkout hidden even when it lives beneath the private
    // writable /tmp. Only its separately selected Git metadata is exposed below.
    "--tmpfs",
    run.pinned.repositoryPath,
  ];
  const mounted = new Set<string>();
  const read = (location: string | undefined) => {
    if (!location || !path.isAbsolute(location) || !fs.existsSync(location)) return;
    const real = fs.realpathSync(location);
    for (const target of new Set([real, location])) {
      if (mounted.has(target)) continue;
      args.push("--ro-bind", real, target);
      mounted.add(target);
    }
  };
  for (const location of [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/etc/ssl",
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/nsswitch.conf",
    "/etc/passwd",
    "/etc/group",
    "/etc/alternatives",
  ])
    read(location);
  // Operator-selected executable directories, not the rest of their home.
  for (const location of (environment.PATH ?? "").split(path.delimiter)) read(location);
  // Node installations (notably nvm) keep Yarn/npm symlink targets and their
  // runtime modules beside bin, under lib/node_modules. Mounting bin alone
  // leaves the advertised package-manager executables broken inside isolation.
  const nodeBin = path.dirname(process.execPath);
  if (path.basename(nodeBin) === "bin" && path.dirname(nodeBin) !== path.parse(nodeBin).root)
    read(path.dirname(nodeBin));
  const home = environment.HOME;
  const config = environment.XDG_CONFIG_HOME ?? (home && path.join(home, ".config"));
  // OpenCode discovers HOME/.opencode even when only its bin directory is on
  // PATH. Exposing bin alone makes existing bootstrap/config files disappear,
  // causing an attempted .gitignore write on the read-only synthetic parent.
  read(home && path.join(home, ".opencode"));
  // Corepack shims need the pre-provisioned package-manager cache even offline.
  // Expose only the default cache, not the surrounding home/cache directories.
  const corepackCache = home && path.join(home, ".cache/node/corepack");
  if (corepackCache && fs.existsSync(corepackCache)) {
    if (fs.realpathSync(corepackCache) !== corepackCache)
      throw new Error("Corepack cache must not resolve outside its configured location");
    read(corepackCache);
  }
  read(environment.OPENCODE_CONFIG);
  read(environment.OPENCODE_CONFIG_DIR ?? (config && path.join(config, "opencode")));
  read(environment.GOOGLE_APPLICATION_CREDENTIALS);
  read(common);
  read(run.pinned.storageRoot);
  read(processSupervisorPath);
  if (!home) throw new Error("OpenCode isolation requires an explicit HOME");
  for (const directory of [
    path.join(home, ".local/share/opencode"),
    path.join(home, ".cache/opencode"),
    path.join(home, ".local/state/opencode"),
  ]) {
    let ancestor = directory;
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    const real = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, directory));
    if (
      real !== directory ||
      [cwd, common, run.pinned.storageRoot, run.pinned.repositoryPath].some(
        (protectedPath) =>
          real === protectedPath ||
          real.startsWith(`${protectedPath}/`) ||
          protectedPath.startsWith(`${real}/`),
      )
    )
      throw new Error("OpenCode state overlaps protected repository/runtime state");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    args.push("--bind", real, directory);
  }
  read(path.join(home, ".local/share/opencode/auth.json"));
  if (refinementResultDirectory !== undefined) {
    const resultRoot = path.join(run.pinned.storageRoot, "refinement-results", run.attemptId);
    if (
      refinementResultDirectory !== resultRoot ||
      fs.realpathSync(resultRoot) !== resultRoot ||
      run.taskKind !== "refinement"
    )
      throw new Error("Refinement result directory differs from owned external artifact");
    args.push("--bind", resultRoot, resultRoot);
    // OpenCode bootstraps project-local metadata even for a read-only run.
    // Present a read-only repository view with a private writable configuration
    // copy so CLI initialization cannot mutate the actual repository contents.
    const configRoot = path.join(run.pinned.storageRoot, "opencode-project-config", run.attemptId);
    fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(configRoot) !== configRoot)
      throw new Error("OpenCode project configuration copy resolves outside owned runtime state");
    const shadow = fs.mkdtempSync(path.join(configRoot, "dispatch-"));
    const projectConfig = path.join(cwd, ".opencode");
    const configStat = fs.lstatSync(projectConfig, { throwIfNoEntry: false });
    if (configStat) {
      if (configStat.isSymbolicLink() || !configStat.isDirectory())
        throw new Error("Refinement project configuration must be a regular directory");
      fs.cpSync(projectConfig, shadow, { recursive: true, dereference: false });
    }
    args.push("--tmpfs", cwd);
    for (const entry of fs.readdirSync(cwd)) {
      if (entry === ".opencode") continue;
      const source = path.join(cwd, entry);
      if (fs.lstatSync(source).isSymbolicLink())
        args.push("--symlink", fs.readlinkSync(source), source);
      else args.push("--ro-bind", source, source);
    }
    args.push("--bind", shadow, projectConfig, "--remount-ro", cwd);
  } else {
    args.push("--bind", cwd, cwd);
  }
  args.push(
    "--ro-bind",
    gitFile,
    gitFile,
    "--remount-ro",
    run.pinned.repositoryPath,
    "--remount-ro",
    "/",
    "--chdir",
    cwd,
    "--",
    process.execPath,
    processSupervisorPath,
    "opencode",
    ...arguments_,
  );
  environment.TMPDIR = "/tmp/opencode";
  return { command: "bwrap", args };
}
