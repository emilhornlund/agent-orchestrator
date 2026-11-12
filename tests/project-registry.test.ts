import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../src/config/config.js";
import {
  acquireProjectOwnership,
  provisionCoordinationNamespace,
} from "../src/coordination/project-ownership.js";
import {
  updateProjectActiveAttempt,
  prepareProjectAttempt,
  readHistoricalProjectPins,
  verifyAndPinProjects,
} from "../src/coordination/project-registry.js";

const execFileAsync = promisify(execFile);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "host-registry-"));
  roots.push(value);
  return value;
}
function config(coordinationRoot: string, contextRoot: string, id: string): Config {
  const project = {
    id,
    trello: {
      boardId: `board-${id}`,
      backlogListId: "backlog",
      readyListId: "ready",
      workingListId: "working",
      reviewListId: "review",
      failedListId: "failed",
      doneListId: "done",
      refinementLabelId: "refine",
      featureLabelId: "feature",
      improvementLabelId: "improve",
      bugLabelId: "bug",
    },
    repository: {
      github: `owner/${id}`,
      path: path.join(contextRoot, "repo"),
      defaultBranch: "main",
      worktreeRoot: path.join(contextRoot, "worktrees"),
    },
  };
  return {
    projects: [project],
    workflow: { contextRoot, coordinationRoot },
  } as unknown as Config;
}

async function pin(value: Config): Promise<void> {
  const project = value.projects[0]!;
  const lease = await acquireProjectOwnership(
    value.workflow.coordinationRoot!,
    {
      trelloBoardId: project.trello.boardId,
      githubRepository: project.repository.github,
    },
    "test",
  );
  try {
    await verifyAndPinProjects(value, [lease]);
  } finally {
    await lease.release();
  }
}

describe("host project registry", () => {
  it("serializes independent concurrent registry transactions without losing inventory", async () => {
    const coordinationRoot = root();
    provisionCoordinationNamespace(coordinationRoot, "test");
    const a = config(coordinationRoot, root(), "alpha");
    const b = config(coordinationRoot, root(), "beta");
    await Promise.all([pin(a), pin(b)]);
    const value = JSON.parse(
      fs.readFileSync(path.join(coordinationRoot, "projects.registry.json"), "utf8"),
    ) as { projects: { projectId: string }[] };
    expect(value.projects.map((entry) => entry.projectId).sort()).toEqual(["alpha", "beta"]);
  });

  it("does not lose updates from separate registry-writer processes", async () => {
    const coordinationRoot = root();
    provisionCoordinationNamespace(coordinationRoot, "test");
    const script = `import {verifyAndPinProjects} from './src/coordination/project-registry.ts'; const id=process.argv[1]; const contextRoot=process.argv[2]; const coordinationRoot=process.argv[3]; const project={id,trello:{boardId:'board-'+id,backlogListId:'b',readyListId:'r',workingListId:'w',reviewListId:'v',failedListId:'f',doneListId:'d',refinementLabelId:'rl',featureLabelId:'fl',improvementLabelId:'il',bugLabelId:'bl'},repository:{github:'owner/'+id,path:contextRoot+'/repo',defaultBranch:'main',worktreeRoot:contextRoot+'/worktrees'}}; const lease={identity:{trelloBoardId:'board-'+id,githubRepository:'owner/'+id}}; await verifyAndPinProjects({projects:[project],workflow:{contextRoot,coordinationRoot}},[lease]);`;
    const spawnOne = (id: string): Promise<unknown> =>
      execFileAsync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script, id, root(), coordinationRoot],
        { cwd: process.cwd() },
      );
    await Promise.all([spawnOne("process-a"), spawnOne("process-b")]);
    const value = JSON.parse(
      fs.readFileSync(path.join(coordinationRoot, "projects.registry.json"), "utf8"),
    ) as { projects: { projectId: string }[] };
    expect(value.projects.map((entry) => entry.projectId).sort()).toEqual([
      "process-a",
      "process-b",
    ]);
  });

  it("persists pending attempt intent before a handoff and prevents relocation after interruption", async () => {
    const coordinationRoot = root();
    provisionCoordinationNamespace(coordinationRoot, "test");
    const oldRoot = root();
    const original = config(coordinationRoot, oldRoot, "handoff");
    const project = original.projects[0]!;
    const lease = await acquireProjectOwnership(
      coordinationRoot,
      {
        trelloBoardId: project.trello.boardId,
        githubRepository: project.repository.github,
      },
      "test",
    );
    try {
      await verifyAndPinProjects(original, [lease]);
      await prepareProjectAttempt(coordinationRoot, project.id, lease, {
        attemptId: "attempt-before-crash",
        storageRoot: oldRoot,
      });
      const recoveredPin = await verifyAndPinProjects(original, [lease]);
      expect(recoveredPin[0]?.pendingAttempt).toEqual({
        attemptId: "attempt-before-crash",
        storageRoot: oldRoot,
      });
    } finally {
      await lease.release();
    }
    await expect(pin(config(coordinationRoot, root(), "handoff"))).rejects.toThrow(
      "interrupted attempt handoff",
    );

    const aliases = [
      {
        id: "same-repository",
        boardId: "board-same-repository",
        repository: "owner/handoff",
      },
      {
        id: "same-board",
        boardId: "board-handoff",
        repository: "owner/different-repository",
      },
    ];
    for (const aliasIdentity of aliases) {
      const base = config(coordinationRoot, root(), aliasIdentity.id);
      const alias = {
        ...base,
        projects: base.projects.map((entry) => ({
          ...entry,
          trello: { ...entry.trello, boardId: aliasIdentity.boardId },
          repository: { ...entry.repository, github: aliasIdentity.repository },
        })),
      } as Config;
      const aliasLease = await acquireProjectOwnership(
        coordinationRoot,
        {
          trelloBoardId: aliasIdentity.boardId,
          githubRepository: aliasIdentity.repository,
        },
        "test",
      );
      try {
        await expect(verifyAndPinProjects(alias, [aliasLease])).rejects.toThrow(
          "redirects a pinned integration",
        );
      } finally {
        await aliasLease.release();
      }
    }
  });

  it("rejects active board reuse independently of repository identity", async () => {
    const coordinationRoot = root();
    provisionCoordinationNamespace(coordinationRoot, "test");
    const project = config(coordinationRoot, root(), "active-a");
    const lease = await acquireProjectOwnership(
      coordinationRoot,
      { trelloBoardId: "board-active-a", githubRepository: "owner/active-a" },
      "test",
    );
    try {
      await verifyAndPinProjects(project, [lease]);
      await updateProjectActiveAttempt(coordinationRoot, "active-a", lease, {
        attemptId: "attempt-a",
        storageRoot: project.workflow.contextRoot,
      });
    } finally {
      await lease.release();
    }
    const sameConfigLease = await acquireProjectOwnership(
      coordinationRoot,
      { trelloBoardId: "board-active-a", githubRepository: "owner/active-a" },
      "test",
    );
    try {
      const samePins = await verifyAndPinProjects(project, [sameConfigLease]);
      expect(samePins[0]?.activeAttempt).toEqual({
        attemptId: "attempt-a",
        storageRoot: project.workflow.contextRoot,
      });
    } finally {
      await sameConfigLease.release();
    }
    const baseAlias = config(coordinationRoot, root(), "alias-b");
    const alias = {
      ...baseAlias,
      projects: baseAlias.projects.map((entry) => ({
        ...entry,
        trello: { ...entry.trello, boardId: "board-active-a" },
      })),
    } as Config;
    const aliasLease = await acquireProjectOwnership(
      coordinationRoot,
      { trelloBoardId: "board-active-a", githubRepository: "owner/alias-b" },
      "test",
    );
    try {
      await expect(verifyAndPinProjects(alias, [aliasLease])).rejects.toThrow(
        "redirects a pinned integration",
      );
    } finally {
      await aliasLease.release();
    }
  });

  it("rejects combined active identity, repository, and storage relocation", async () => {
    const coordinationRoot = root();
    provisionCoordinationNamespace(coordinationRoot, "test");
    const initial = config(coordinationRoot, root(), "protected");
    const initialProject = initial.projects[0]!;
    const initialLease = await acquireProjectOwnership(
      coordinationRoot,
      {
        trelloBoardId: initialProject.trello.boardId,
        githubRepository: initialProject.repository.github,
      },
      "test",
    );
    try {
      await verifyAndPinProjects(initial, [initialLease]);
      await updateProjectActiveAttempt(coordinationRoot, "protected", initialLease, {
        attemptId: "active-attempt",
        storageRoot: initial.workflow.contextRoot,
      });
    } finally {
      await initialLease.release();
    }

    const changed = config(coordinationRoot, root(), "protected");
    const changedConfig = {
      ...changed,
      projects: changed.projects.map((project) => ({
        ...project,
        trello: { ...project.trello, boardId: "board-renamed" },
        repository: {
          ...project.repository,
          github: "owner/redirected",
          path: path.join(changed.workflow.contextRoot, "moved-repo"),
        },
      })),
    } as Config;
    const changedLease = await acquireProjectOwnership(
      coordinationRoot,
      { trelloBoardId: "board-renamed", githubRepository: "owner/redirected" },
      "test",
    );
    try {
      await expect(verifyAndPinProjects(changedConfig, [changedLease])).rejects.toThrow(
        'Active project "protected"',
      );
    } finally {
      await changedLease.release();
    }
  });

  it("retains repeated inactive pin revisions across active-reference updates", async () => {
    const coordinationRoot = root();
    provisionCoordinationNamespace(coordinationRoot, "test");
    const oldConfig = config(coordinationRoot, root(), "reconfigured");
    await pin(oldConfig);
    const secondConfig = config(coordinationRoot, root(), "reconfigured");
    await pin(secondConfig);
    const otherProject = config(coordinationRoot, root(), "unrelated");
    await pin(otherProject);
    const project = secondConfig.projects[0]!;
    const lease = await acquireProjectOwnership(
      coordinationRoot,
      {
        trelloBoardId: project.trello.boardId,
        githubRepository: project.repository.github,
      },
      "test",
    );
    try {
      await updateProjectActiveAttempt(coordinationRoot, "reconfigured", lease, {
        attemptId: "between-config-revisions",
        storageRoot: secondConfig.workflow.contextRoot,
      });
      await updateProjectActiveAttempt(coordinationRoot, "reconfigured", lease, null);
    } finally {
      await lease.release();
    }
    const thirdConfig = config(coordinationRoot, root(), "reconfigured");
    await pin(thirdConfig);
    const fourthConfig = config(coordinationRoot, root(), "reconfigured");
    await pin(fourthConfig);
    const history = await readHistoricalProjectPins(coordinationRoot, "reconfigured");
    expect(history.map((pin) => pin.storageRoot)).toEqual([
      oldConfig.workflow.contextRoot,
      secondConfig.workflow.contextRoot,
      thirdConfig.workflow.contextRoot,
    ]);
    const registry = JSON.parse(
      fs.readFileSync(path.join(coordinationRoot, "projects.registry.json"), "utf8"),
    ) as { projects: { projectId: string }[] };
    expect(registry.projects.map((pin) => pin.projectId)).toContain("unrelated");
  });

  it("refuses a lease for one integration to mutate another project's reference", async () => {
    const coordinationRoot = root();
    provisionCoordinationNamespace(coordinationRoot, "test");
    const a = config(coordinationRoot, root(), "alpha");
    const b = config(coordinationRoot, root(), "beta");
    await pin(a);
    await pin(b);
    const lease = await acquireProjectOwnership(
      coordinationRoot,
      { trelloBoardId: "board-alpha", githubRepository: "owner/alpha" },
      "test",
    );
    try {
      await expect(
        updateProjectActiveAttempt(coordinationRoot, "beta", lease, {
          attemptId: "attempt-1",
          storageRoot: b.workflow.contextRoot,
        }),
      ).rejects.toThrow("does not authorize");
    } finally {
      await lease.release();
    }
  });

  it("preserves malformed and symlink registry files", async () => {
    const coordinationRoot = root();
    provisionCoordinationNamespace(coordinationRoot, "test");
    const file = path.join(coordinationRoot, "projects.registry.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        generation: 1,
        projects: [{ projectId: "bad" }],
      }),
      { mode: 0o600 },
    );
    await expect(pin(config(coordinationRoot, root(), "alpha"))).rejects.toThrow(
      "Malformed project registry",
    );
    fs.unlinkSync(file);
    const target = path.join(coordinationRoot, "target");
    fs.writeFileSync(target, "{}", { mode: 0o600 });
    fs.symlinkSync(target, file);
    await expect(pin(config(coordinationRoot, root(), "alpha"))).rejects.toThrow(
      "Unsafe project registry",
    );
  });
});
