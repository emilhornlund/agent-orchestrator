import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { createPublicationFixture } from "./support/initial-publication-fixture.js";
import ts from "typescript";

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
  for (const relative of [
    "process/contained-process",
    "process/process-runtime",
    "security/redact-secrets",
  ]) {
    const helper = ts.transpileModule(
      fs.readFileSync(new URL(`../src/${relative}.ts`, import.meta.url), "utf8"),
      {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
      },
    ).outputText;
    const target = path.join(f.worktreePath, "src", `${relative}.js`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, helper);
  }
  fs.writeFileSync(path.join(f.worktreePath, "package.json"), '{"type":"module"}');
  fs.mkdirSync(path.join(f.worktreePath, "scripts"));
  fs.copyFileSync(
    new URL("../scripts/contained-process-supervisor.mjs", import.meta.url),
    path.join(f.worktreePath, "scripts/contained-process-supervisor.mjs"),
  );
  const tempName = `private-temp-${path.basename(root)}`;
  const nestedCheck = `const fs=require('node:fs'); const os=require('node:os');
for (const p of ${JSON.stringify(protectedPaths)}) { try {fs.writeFileSync(p,'unsafe');process.exit(41)} catch {} }
if (process.env.TMPDIR !== undefined || os.tmpdir() !== '/tmp') process.exit(42);
fs.mkdirSync('/tmp/${tempName}'); fs.writeFileSync('/tmp/${tempName}/scratch','private');`;
  const nested = `import {containedProcess} from './src/process/contained-process.js';
import {spawnSync} from 'node:child_process';
const dispatch=containedProcess(process.execPath,['-e',${JSON.stringify(nestedCheck)}]);
const result=spawnSync(dispatch.command,dispatch.args,{env:{PATH:process.env.PATH,HOME:process.env.HOME},encoding:'utf8',stdio:['ignore','pipe','pipe','pipe','pipe']});
if(result.status!==0){process.stderr.write(result.stderr??'');process.exit(result.status??43)}`;
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
const nested=spawnSync(${JSON.stringify(process.execPath)},['--input-type=module','-e',${JSON.stringify(nested)}],{encoding:'utf8'});
if(nested.status!==0){process.stderr.write(nested.stderr??'');process.exit(nested.status??44)}
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
  expect(fs.existsSync(`/tmp/${tempName}`)).toBe(false);
  expect(await f.git.getCurrentBranch(f.worktreePath)).toBe("agent/card");
});
