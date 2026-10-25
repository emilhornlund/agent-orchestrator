import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import {
  PrMaintenanceConflictError,
  PrMaintenanceStore,
} from "../src/task-session/pr-maintenance-store.js";
import type { PrMaintenanceOperation } from "../src/task-session/pr-maintenance-operation.js";

let root: string | undefined;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function setup(projectId = "project-a") {
  root ??= fs.mkdtempSync(path.join(os.tmpdir(), "pr-maintenance-"));
  const project = {
    id: projectId,
    repository: {
      path: path.join(root, `repo-${projectId}`),
      worktreeRoot: path.join(root, `worktrees-${projectId}`),
    },
  } as ProjectConfig;
  fs.mkdirSync(project.repository.path, { recursive: true });
  fs.mkdirSync(project.repository.worktreeRoot, { recursive: true });
  const contextRoot = path.join(root, "context");
  return {
    project,
    contextRoot,
    store: new PrMaintenanceStore(contextRoot, project),
  };
}

const sha = (digit: string) => digit.repeat(40);
function operation(
  overrides: Partial<Omit<PrMaintenanceOperation, "version" | "status">> = {},
) {
  return {
    projectId: "project-a",
    cardId: "card-1",
    pullRequest: {
      number: 123,
      url: "https://github.com/example/repo/pull/123",
    },
    expectedRemoteHead: sha("a"),
    targetBaseHead: sha("b"),
    operationId: "maintenance-1",
    createdAt: "2026-10-24T09:00:00.000Z",
    updatedAt: "2026-10-24T09:00:00.000Z",
    ...overrides,
  };
}
const identity = (overrides: Record<string, unknown> = {}) =>
  ({
    projectId: "project-a",
    cardId: "card-1",
    pullRequest: {
      number: 123,
      url: "https://github.com/example/repo/pull/123",
    },
    expectedRemoteHead: sha("a"),
    targetBaseHead: sha("b"),
    ...overrides,
  }) as Pick<
    PrMaintenanceOperation,
    | "projectId"
    | "cardId"
    | "pullRequest"
    | "expectedRemoteHead"
    | "targetBaseHead"
  >;

describe("PrMaintenanceStore", () => {
  it("persists versioned operations under context root and rejects duplicate operation IDs", () => {
    const { store, contextRoot, project } = setup();
    const created = store.create(operation());
    expect(created).toMatchObject({
      version: 1,
      status: "prepared",
      operationId: "maintenance-1",
    });
    expect(store.inspect("maintenance-1")).toEqual(created);
    expect(
      fs.existsSync(
        path.join(contextRoot, "pr-maintenance", `${project.id}.json`),
      ),
    ).toBe(true);
    expect(() => store.create(operation())).toThrow(PrMaintenanceConflictError);
  });

  it("allows only one incomplete operation per project and isolates projects", () => {
    const { store } = setup();
    store.create(operation());
    expect(() =>
      store.create(
        operation({ operationId: "maintenance-2", cardId: "card-2" }),
      ),
    ).toThrow(/already owns this project/);
    expect(
      setup("project-b").store.create(operation({ projectId: "project-b" }))
        .status,
    ).toBe("prepared");
  });

  it("enforces valid transitions, exclusive active ownership, and identity", () => {
    const { store, contextRoot, project } = setup();
    store.create(operation());
    expect(() =>
      store.advance("maintenance-1", "prepared", "completed", identity()),
    ).toThrow(/Invalid/);
    expect(() =>
      store.advance(
        "maintenance-1",
        "prepared",
        "active",
        identity({ cardId: "other-card" }),
      ),
    ).toThrow(/identity/);
    expect(
      store.advance("maintenance-1", "prepared", "active", identity()).status,
    ).toBe("active");
    const contender = new PrMaintenanceStore(contextRoot, project);
    expect(() =>
      contender.advance("maintenance-1", "active", "completed", identity()),
    ).toThrow(/owned by another process/);
    expect(() =>
      store.advance("maintenance-1", "active", "prepared", identity()),
    ).toThrow(/Invalid/);
    expect(
      store.advance("maintenance-1", "active", "completed", identity()).status,
    ).toBe("completed");
  });

  it.each([
    ["cardId", { cardId: "wrong-card" }],
    [
      "PR number",
      {
        pullRequest: {
          number: 124,
          url: "https://github.com/example/repo/pull/123",
        },
      },
    ],
    [
      "PR URL",
      {
        pullRequest: {
          number: 123,
          url: "https://github.com/example/repo/pull/999",
        },
      },
    ],
    ["remote head", { expectedRemoteHead: sha("c") }],
    ["base head", { targetBaseHead: sha("d") }],
  ])("rejects a mismatched %s identity", (_label, mismatch) => {
    const { store } = setup();
    store.create(operation());
    expect(() =>
      store.advance("maintenance-1", "prepared", "active", identity(mismatch)),
    ).toThrow(/identity/);
  });

  it("preserves prepared operations across restart and retains incomplete state on uncertain outcome", () => {
    const { store, contextRoot, project } = setup();
    store.create(operation());
    const restarted = new PrMaintenanceStore(contextRoot, project);
    expect(restarted.inspect("maintenance-1")?.status).toBe("prepared");
    restarted.advance("maintenance-1", "prepared", "active", identity());
    restarted.advance("maintenance-1", "active", "uncertain", identity());
    expect(restarted.inspect("maintenance-1")?.status).toBe("uncertain");
    expect(() =>
      restarted.create(operation({ operationId: "maintenance-2" })),
    ).toThrow(/already owns this project/);
  });

  it("reconciles stale ownership without releasing the incomplete operation", () => {
    const { store, contextRoot, project } = setup();
    store.create(operation());
    store.advance("maintenance-1", "prepared", "active", identity());
    const filePath = path.join(
      contextRoot,
      "pr-maintenance",
      `${project.id}.json`,
    );
    const state = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      operations: Array<{ ownerToken: string; ownerPid: number }>;
    };
    state.operations[0]!.ownerToken = "00000000-0000-4000-8000-000000000001";
    state.operations[0]!.ownerPid = 2_147_483_647;
    fs.writeFileSync(filePath, JSON.stringify(state));
    const restarted = new PrMaintenanceStore(contextRoot, project);
    expect(
      restarted.reconcileInterrupted("maintenance-1", identity()).status,
    ).toBe("uncertain");
    expect(
      restarted.reconcileInterrupted("maintenance-1", identity()).status,
    ).toBe("uncertain");
    expect(() =>
      restarted.create(operation({ operationId: "maintenance-2" })),
    ).toThrow(/already owns this project/);
  });

  it("completes idempotently and permits a subsequent operation", () => {
    const { store } = setup();
    store.create(operation());
    const completed = store.advance(
      "maintenance-1",
      "prepared",
      "active",
      identity(),
    );
    const done = store.advance(
      "maintenance-1",
      "active",
      "completed",
      identity(),
    );
    expect(
      store.advance("maintenance-1", "completed", "completed", identity()),
    ).toEqual(done);
    expect(done.updatedAt).toBeTruthy();
    expect(completed.status).toBe("active");
    expect(
      store.create(operation({ operationId: "maintenance-2" })).status,
    ).toBe("prepared");
  });
});
