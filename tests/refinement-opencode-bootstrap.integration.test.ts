import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { notificationAuthorityFixture } from "./support/notification-authority-fixture.js";
import type { ProjectOwnershipLease } from "../src/coordination/project-ownership.js";
import { spawnSync } from "node:child_process";
import { isolatedOpenCodeDispatch } from "../src/opencode/isolated-dispatch.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { runRefinement } from "../src/refinement/run-refinement.js";
import { RefinementSetupAmbiguousError } from "../src/refinement/run-refinement-setup.js";
import { getRefinementResultPath } from "../src/refinement/refinement-result.js";
import { prepareWorktree } from "../src/git/prepare-worktree.js";

const roots: string[] = [];
const leases: ProjectOwnershipLease[] = [];
afterEach(async () => {
  for (const lease of leases.splice(0)) await lease.release();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it.each([false, true])(
  "preserves refinement analysis allowance on provider failure and resumes after recovery (interrupted=%s)",
  async (interrupted) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "refinement-provider-"));
    roots.push(root);
    const f = await notificationAuthorityFixture(root, "provider", undefined, true, "refinement");
    leases.push(f.lease);
    const worktree = await f.authority.run(() => prepareWorktree(f.git, f.project, f.card.id));
    const bin = path.join(root, "bin");
    const home = path.join(root, "home");
    fs.mkdirSync(bin);
    fs.mkdirSync(home);
    const resultPath = f.authority.run(() => getRefinementResultPath(worktree.path));
    fs.writeFileSync(
      path.join(bin, "opencode"),
      `#!${process.execPath}
const fs=require('node:fs');
const marker=process.env.HOME+'/.local/share/opencode/provider-outage-observed';
if(!fs.existsSync(marker)) {
  fs.writeFileSync(marker, 'observed');
  if(process.argv.includes('--format') && process.argv.includes('json'))
    fs.writeSync(1, JSON.stringify({type:'error',error:{name:'APIError',data:{statusCode:503}}})+'\\n');
  else fs.writeSync(2, 'Error: provider unavailable');
  process.exit(1);
}
fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({title:'Refined after provider recovery',description:'Repository-grounded task',type:'improvement'}));
`,
      { mode: 0o700 },
    );
    const transport = new OpenCodeClient();
    let interruptAfterResult = interrupted;
    const client = new OpenCodeClient((options) =>
      transport
        .run({
          ...options,
          environment: {
            HOME: home,
            PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
          },
        })
        .then((result) => {
          if (interruptAfterResult && result.failureClassification === "dependency-outage") {
            interruptAfterResult = false;
            throw new RefinementSetupAmbiguousError(
              "Controller interrupted after provider result persisted",
            );
          }
          return result;
        }),
    );
    const refine = () =>
      f.authority.run(() =>
        runRefinement(
          f.git,
          client,
          f.project,
          f.card,
          worktree.path,
          new AbortController().signal,
        ),
      );
    await expect(refine()).rejects.toBeInstanceOf(RefinementSetupAmbiguousError);
    if (interrupted) {
      expect(f.authority.read("refinement-analysis-v1", (value) => value)).toMatchObject({
        attempts: 1,
        status: "active",
      });
      await expect(refine()).rejects.toBeInstanceOf(RefinementSetupAmbiguousError);
    }
    expect(f.authority.read("refinement-analysis-v1", (value) => value)).toMatchObject({
      attempts: 0,
      status: "pending",
    });
    await expect(refine()).resolves.toMatchObject({
      title: "Refined after provider recovery",
      type: "improvement",
    });
    expect(f.authority.read("refinement-analysis-v1", (value) => value)).toMatchObject({
      attempts: 1,
      status: "complete",
    });
    expect(await f.git.getStatus(worktree.path)).toBe("");
  },
);

it.each([false, true])(
  "allows refinement CLI bootstrap without changing repository content (existing config=%s)",
  async (existing) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "refinement-bootstrap-"));
    roots.push(root);
    const f = await notificationAuthorityFixture(root, "bootstrap", undefined, true, "refinement");
    leases.push(f.lease);
    const worktree = await f.authority.run(() => prepareWorktree(f.git, f.project, f.card.id));
    const config = path.join(worktree.path, ".opencode");
    if (existing) {
      fs.mkdirSync(path.join(config, "agents"), { recursive: true });
      fs.writeFileSync(
        path.join(config, "agents", "refine.md"),
        "Repository-specific instructions",
      );
    }
    const bin = path.join(root, "bin");
    const home = path.join(root, "home");
    fs.mkdirSync(bin);
    fs.mkdirSync(home);
    const resultRoot = path.join(
      f.project.contextRoot,
      "refinement-results",
      f.authority.store.attemptId,
    );
    fs.mkdirSync(resultRoot, { recursive: true });
    fs.writeFileSync(
      path.join(bin, "opencode"),
      `#!${process.execPath}
const fs=require('node:fs');
if (${existing} && fs.readFileSync('.opencode/agents/refine.md','utf8') !== 'Repository-specific instructions') process.exit(31);
fs.writeFileSync('.opencode/.gitignore','CLI bootstrap metadata');
fs.writeFileSync('.opencode/package.json','{}');
for(const p of ['source.txt','new-source.txt','.git',${JSON.stringify(path.join(f.project.repository.path, "intrusion"))}]) {
  try {fs.writeFileSync(p,'unsafe');process.exit(32);} catch {}
}
fs.writeFileSync(${JSON.stringify(path.join(resultRoot, "result.json"))}, JSON.stringify({title:'Refined',description:'Evidence-grounded task',type:'improvement'}));
process.stdout.write('refinement completed');
`,
      { mode: 0o700 },
    );
    const before = await f.git.getStatus(worktree.path);
    const environment = {
      HOME: home,
      PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    };
    const dispatch = isolatedOpenCodeDispatch(
      f.authority,
      worktree.path,
      environment,
      ["run"],
      resultRoot,
    );
    const result = spawnSync(dispatch.command, dispatch.args, {
      cwd: worktree.path,
      env: environment,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(resultRoot, "result.json"), "utf8")).type).toBe(
      "improvement",
    );
    expect(await f.git.getStatus(worktree.path)).toBe(before);
    expect(fs.existsSync(path.join(config, ".gitignore"))).toBe(false);
    expect(fs.existsSync(path.join(config, "package.json"))).toBe(false);
    expect(fs.existsSync(path.join(f.project.repository.path, "intrusion"))).toBe(false);
    if (existing)
      expect(fs.readFileSync(path.join(config, "agents", "refine.md"), "utf8")).toBe(
        "Repository-specific instructions",
      );
  },
);
