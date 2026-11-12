import fs from "node:fs";
import path from "node:path";
import { runTaskResources } from "../task-session/task-resources.js";
import type { ProjectRunAuthority } from "../task-session/project-run-authority.js";

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
  const home = environment.HOME;
  const config = environment.XDG_CONFIG_HOME ?? (home && path.join(home, ".config"));
  read(environment.OPENCODE_CONFIG);
  read(environment.OPENCODE_CONFIG_DIR ?? (config && path.join(config, "opencode")));
  read(environment.GOOGLE_APPLICATION_CREDENTIALS);
  read(common);
  read(run.pinned.storageRoot);
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
  }
  args.push(
    refinementResultDirectory === undefined ? "--bind" : "--ro-bind",
    cwd,
    cwd,
    "--ro-bind",
    gitFile,
    gitFile,
    "--remount-ro",
    "/tmp",
    "--remount-ro",
    "/",
    "--chdir",
    cwd,
    "--",
    "opencode",
    ...arguments_,
  );
  environment.TMPDIR = "/tmp/opencode";
  return { command: "bwrap", args };
}
