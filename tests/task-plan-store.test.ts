import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import {
  TaskPlanConflictError,
  TaskPlanStore,
  type StoredTaskPlan,
} from "../src/task-session/task-plan-store.js";
import type { TaskPlan } from "../src/task-session/task-plan.js";

let temporaryRoot: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();

  if (temporaryRoot !== undefined) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

function createFixture(): {
  plan: TaskPlan;
  project: ProjectConfig;
  root: string;
  store: TaskPlanStore;
} {
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-plan-store-"),
  );
  const project = {
    id: "project-one",
    repository: {
      path: path.join(temporaryRoot, "repository"),
      worktreeRoot: path.join(temporaryRoot, "worktrees"),
    },
  } as ProjectConfig;
  fs.mkdirSync(project.repository.path);
  fs.mkdirSync(project.repository.worktreeRoot);
  const root = path.join(temporaryRoot, "runtime-state");
  const plan: TaskPlan = {
    version: 1,
    projectId: project.id,
    cardId: "card-one",
    requirements: [
      {
        id: "REQ-1",
        text: "Preserve the task requirements.",
        verification: "Compare the plan to the original card.",
      },
    ],
    steps: [
      {
        id: "STEP-1",
        description: "Implement the requested behavior.",
        requirementIds: ["REQ-1"],
        verification: "Run the focused test suite.",
      },
    ],
    assumptions: [],
    blockers: [],
  };

  return { plan, project, root, store: new TaskPlanStore(root, project) };
}

function revisedPlan(plan: TaskPlan): TaskPlan {
  return {
    ...plan,
    steps: [
      {
        ...plan.steps[0]!,
        description: "Implement and test the requested behavior.",
      },
    ],
  };
}

function planFilePath(root: string, plan: TaskPlan): string {
  return path.join(root, "task-plans", plan.projectId, `${plan.cardId}.json`);
}

describe("TaskPlanStore", () => {
  it("round-trips a plan with its plan and task-record revisions", () => {
    const { plan, store } = createFixture();

    expect(store.create(plan, 7)).toEqual({
      version: 1,
      planRevision: 1,
      taskRecordRevision: 7,
      plan,
    });
    expect(store.read(plan.cardId, 7)).toEqual({
      version: 1,
      planRevision: 1,
      taskRecordRevision: 7,
      plan,
    } satisfies StoredTaskPlan);
    expect(store.read("missing-card")).toBeNull();
  });

  it("updates plan revisions with compare-and-swap and rejects stale writes", () => {
    const { plan, store } = createFixture();
    store.create(plan, 7);

    expect(store.compareAndSwap(plan.cardId, 1, revisedPlan(plan), 8)).toEqual({
      version: 1,
      planRevision: 2,
      taskRecordRevision: 8,
      plan: revisedPlan(plan),
    });
    expect(() =>
      store.compareAndSwap(plan.cardId, 1, revisedPlan(plan), 8),
    ).toThrow(TaskPlanConflictError);
    expect(() => store.read(plan.cardId, 7)).toThrow(
      "associated with task record revision 8",
    );
  });

  it("preserves malformed authoritative plan data", () => {
    const { plan, root, store } = createFixture();
    store.create(plan, 7);
    const filePath = planFilePath(root, plan);
    fs.writeFileSync(filePath, "{malformed", "utf8");

    expect(() => store.read(plan.cardId)).toThrow("Could not parse task plan");
    expect(() => store.create(plan, 7)).toThrow("Could not parse task plan");
    expect(fs.readFileSync(filePath, "utf8")).toBe("{malformed");
  });

  it("rejects wrong-task plan identity without changing the file", () => {
    const { plan, root, store } = createFixture();
    store.create(plan, 7);
    const filePath = planFilePath(root, plan);
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      plan: TaskPlan;
    };
    fs.writeFileSync(
      filePath,
      JSON.stringify({ ...stored, plan: { ...plan, cardId: "other-card" } }),
      "utf8",
    );
    const contentsBeforeRead = fs.readFileSync(filePath, "utf8");

    expect(() => store.read(plan.cardId)).toThrow("identity does not match");
    expect(fs.readFileSync(filePath, "utf8")).toBe(contentsBeforeRead);
    expect(() =>
      store.create({ ...plan, projectId: "another-project" }, 7),
    ).toThrow("project ID does not match");
  });

  it("rejects unsafe card IDs and roots overlapping repository worktrees", () => {
    const { plan, project, store } = createFixture();

    expect(() => store.read("../card-one")).toThrow("Invalid card ID");
    expect(() => new TaskPlanStore(project.repository.path, project)).toThrow(
      "must not overlap",
    );
    expect(
      () =>
        new TaskPlanStore(
          path.join(project.repository.worktreeRoot, "runtime-state"),
          project,
        ),
    ).toThrow("must not overlap");
    expect(() => new TaskPlanStore("relative-root", project)).toThrow(
      "absolute path",
    );
    expect(store.read(plan.cardId)).toBeNull();
  });

  it("preserves the previous plan and cleans temporary files after write failure", () => {
    const { plan, root, store } = createFixture();
    store.create(plan, 7);
    const nextPlan = revisedPlan(plan);
    const fsync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw new Error("simulated plan write failure");
    });

    expect(() => store.compareAndSwap(plan.cardId, 1, nextPlan, 8)).toThrow(
      "simulated plan write failure",
    );
    fsync.mockRestore();

    expect(store.read(plan.cardId, 7)).toMatchObject({
      planRevision: 1,
      plan,
    });
    expect(fs.readdirSync(path.dirname(planFilePath(root, plan)))).toEqual([
      "card-one.json",
    ]);
  });

  it("enforces the serialized plan size limit before publishing", () => {
    const { plan, root, store } = createFixture();
    const oversized: TaskPlan = {
      ...plan,
      assumptions: ["x".repeat(1024 * 1024)],
    };

    expect(() => store.create(oversized, 7)).toThrow("exceeds the");
    expect(fs.existsSync(planFilePath(root, plan))).toBe(false);
  });
});
