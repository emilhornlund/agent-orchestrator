import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { createPublicationFixture } from "./support/initial-publication-fixture.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("confines the actual writable OpenCode child and its descendants to task content and session state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-isolation-"));
  roots.push(root);
  const f = createPublicationFixture(root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(home, ".opencode"));
  fs.writeFileSync(path.join(home, ".opencode", ".gitignore"), "node_modules\n");
  const metadata = path.resolve(
    f.worktreePath,
    fs.readFileSync(path.join(f.worktreePath, ".git"), "utf8").trim().slice(8),
  );
  const common = fs.realpathSync(path.resolve(metadata, "../.."));
  const protectedPaths = [
    path.join(f.project.repository.path, "intrusion"),
    path.join(metadata, "HEAD"),
    path.join(metadata, "index"),
    path.join(common, "refs/heads/intrusion"),
    path.join(f.project.contextRoot, "intrusion"),
  ];
  const attachment = path.join(f.project.contextRoot, "attachment.txt");
  fs.writeFileSync(attachment, "task attachment context");
  fs.writeFileSync(
    path.join(bin, "opencode"),
    `#!${process.execPath}\nconst fs = require('node:fs'); const {spawnSync} = require('node:child_process');
const paths = ${JSON.stringify(protectedPaths)};
if (fs.readFileSync(${JSON.stringify(attachment)}, 'utf8') !== 'task attachment context') process.exit(35);
if (fs.readFileSync(process.env.HOME + '/.opencode/.gitignore', 'utf8') !== 'node_modules\\n') process.exit(36);
try { fs.writeFileSync(process.env.HOME + '/.opencode/.gitignore', 'unsafe'); process.exit(37); } catch {}
fs.writeFileSync(process.env.HOME + '/.local/share/opencode/session-test', 'session state');
fs.writeFileSync(process.env.TMPDIR + '/scratch', 'scratch');
for (const p of paths) { try { fs.writeFileSync(p, 'unsafe'); process.exit(31); } catch {} }
const child = spawnSync(${JSON.stringify(process.execPath)}, ['-e', "try {require('node:fs').writeFileSync(" + JSON.stringify(paths[0]) + ", 'unsafe'); process.exit(32)} catch {}"]);
if (child.status !== 0) process.exit(33);
fs.writeFileSync('task-output', 'meaningful output');
try { fs.unlinkSync('.git'); process.exit(34); } catch {}
console.log('isolated');\n`,
    { mode: 0o700 },
  );
  const result = await f.authority.run(() =>
    new OpenCodeClient().run({
      cwd: f.worktreePath,
      model: "openai/test",
      prompt: "implement",
      environment: {
        PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: home,
      },
      timeoutMilliseconds: 10_000,
      signal: new AbortController().signal,
    }),
  );
  expect(result.exitCode, result.errorOutput).toBe(0);
  expect(result.output).toContain("isolated");
  expect(fs.readFileSync(path.join(f.worktreePath, "task-output"), "utf8")).toBe(
    "meaningful output",
  );
  expect(fs.existsSync(protectedPaths[0]!)).toBe(false);
  expect(await f.git.getCurrentBranch(f.worktreePath)).toBe("agent/card");
});
