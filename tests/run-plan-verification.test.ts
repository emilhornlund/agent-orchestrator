import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import {
  OpenCodeClient,
  type RunOpenCode,
} from "../src/opencode/opencode-client.js";
import { runPlanVerification } from "../src/task-session/run-plan-verification.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { TaskPlanStore } from "../src/task-session/task-plan-store.js";
import type { TaskPlan } from "../src/task-session/task-plan.js";
import type { PlanVerificationResult } from "../src/task-session/plan-verification.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

let temporaryRoot: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();

  if (temporaryRoot !== undefined) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

const projectId = "project-one";
const card: TrelloCard = {
  id: "card-one",
  name: "Add the settings page",
  desc: "Persist the requested settings and provide an accessible interface.",
  idList: "ready-list",
  idLabels: ["feature-label"],
  url: "https://trello.example/card-one",
};

const plan: TaskPlan = {
  version: 1,
  projectId,
  cardId: card.id,
  requirements: [
    {
      id: "REQ-1",
      text: "Persist user settings.",
      verification: "Reload saved settings in a test.",
    },
    {
      id: "REQ-2",
      text: "Provide an accessible interface.",
      verification: "Verify accessible labels in a component test.",
    },
  ],
  steps: [
    {
      id: "STEP-1",
      description: "Implement settings UI and persistence.",
      requirementIds: ["REQ-1", "REQ-2"],
      verification: "Run the focused settings tests.",
    },
  ],
  assumptions: [],
  blockers: [],
};

function createFixture(): {
  executionStore: TaskExecutionStore;
  planStore: TaskPlanStore;
} {
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-plan-verification-"),
  );
  const project = {
    id: projectId,
    repository: {
      path: path.join(temporaryRoot, "repository"),
      worktreeRoot: path.join(temporaryRoot, "worktrees"),
    },
  } as ProjectConfig;
  fs.mkdirSync(project.repository.path);
  fs.mkdirSync(project.repository.worktreeRoot);
  const storageRoot = path.join(temporaryRoot, "runtime-state");
  const executionStore = new TaskExecutionStore(storageRoot, project);
  const planStore = new TaskPlanStore(storageRoot, project);

  executionStore.create({
    version: 1,
    projectId,
    cardId: card.id,
    phase: "planning",
    primarySessionId: "ses_primary-task-session",
    sessionCreationStatus: "bound",
    operationKey: "planning-operation",
    revision: 1,
    retryCounters: {
      validation: 0,
      review: 0,
      ci: 0,
      humanFeedback: 0,
    },
    createdAt: "2026-10-24T09:00:00.000Z",
    updatedAt: "2026-10-24T09:00:00.000Z",
  });
  planStore.create(plan, 1);

  return { executionStore, planStore };
}

function verification(
  overrides: Partial<PlanVerificationResult> = {},
): PlanVerificationResult {
  return {
    version: 1,
    projectId,
    cardId: card.id,
    planRevision: 1,
    verdict: "pass",
    findings: [],
    ...overrides,
  };
}

function runOpenCodeWithResult(result: PlanVerificationResult | string) {
  return vi.fn<RunOpenCode>().mockResolvedValue({
    exitCode: 0,
    output: typeof result === "string" ? result : JSON.stringify(result),
    errorOutput: "",
  });
}

function options(
  executionStore: TaskExecutionStore,
  planStore: TaskPlanStore,
  openCode: OpenCodeClient,
) {
  return {
    taskRecordStore: executionStore,
    planStore,
    openCode,
    projectId,
    card,
    runOptions: {
      cwd: "/owned/worktree",
      model: "review-model",
      variant: "high",
      timeoutMilliseconds: 60_000,
      signal: new AbortController().signal,
    },
  };
}

describe("runPlanVerification", () => {
  it("independently approves and persists a plan verdict", async () => {
    const { executionStore, planStore } = createFixture();
    const runOpenCode = runOpenCodeWithResult(verification());
    const result = await runPlanVerification(
      options(executionStore, planStore, new OpenCodeClient(runOpenCode)),
    );

    expect(result.verification.verdict).toBe("pass");
    expect(planStore.read(card.id, 1)?.verification).toEqual(
      result.verification,
    );
    expect(planStore.read(card.id)?.planRevision).toBe(1);
    expect(executionStore.read(card.id)?.phase).toBe("planning");
    expect(runOpenCode.mock.calls[0]?.[0]).toMatchObject({
      model: "review-model",
      prompt: expect.stringContaining(card.desc),
    });
    expect(runOpenCode.mock.calls[0]?.[0].prompt).toContain("invented-scope");
    expect(runOpenCode.mock.calls[0]?.[0].prompt).toContain(
      "Do not implement the task",
    );
    expect(runOpenCode.mock.calls[0]?.[0].sessionId).toBeUndefined();
  });

  it.each([
    ["omitted criterion", "missing-requirement", "REQ-2"],
    ["invented scope", "invented-scope", undefined],
  ] as const)(
    "persists a blocking finding for %s without advancing task phase",
    async (_description, kind, requirementId) => {
      const { executionStore, planStore } = createFixture();
      const failedResult = verification({
        verdict: "fail",
        findings: [
          {
            kind,
            ...(requirementId === undefined ? {} : { requirementId }),
            detail:
              kind === "missing-requirement"
                ? "REQ-2 is absent from the proposed steps."
                : "The plan adds an unrelated account-management feature.",
          },
        ],
      });
      const runOpenCode = runOpenCodeWithResult(failedResult);

      const result = await runPlanVerification(
        options(executionStore, planStore, new OpenCodeClient(runOpenCode)),
      );

      expect(result.verification.verdict).toBe("fail");
      expect(result.verification.findings).toEqual(failedResult.findings);
      expect(planStore.read(card.id, 1)?.verification).toEqual(failedResult);
      expect(executionStore.read(card.id)?.phase).toBe("planning");
    },
  );

  it.each([
    ["malformed JSON", "not JSON"],
    [
      "mismatched plan revision",
      JSON.stringify(verification({ planRevision: 2 })),
    ],
    [
      "failed verdict without concrete findings",
      JSON.stringify(verification({ verdict: "fail", findings: [] })),
    ],
  ])("rejects a %s and does not persist an outcome", async (_case, output) => {
    const { executionStore, planStore } = createFixture();
    const runOpenCode = runOpenCodeWithResult(output);

    await expect(
      runPlanVerification(
        options(executionStore, planStore, new OpenCodeClient(runOpenCode)),
      ),
    ).rejects.toThrow();

    expect(planStore.read(card.id)?.verification).toBeUndefined();
    expect(executionStore.read(card.id)?.phase).toBe("planning");
  });

  it("refuses verification after the task record has moved to another phase", async () => {
    const { executionStore, planStore } = createFixture();
    const record = executionStore.read(card.id);

    if (record === null) {
      throw new Error("Expected task execution record");
    }

    executionStore.compareAndSwap(card.id, record.revision, {
      ...record,
      phase: "attention-required",
      revision: record.revision + 1,
      updatedAt: "2026-10-24T09:01:00.000Z",
    });
    const runOpenCode = vi.fn<RunOpenCode>();

    await expect(
      runPlanVerification(
        options(executionStore, planStore, new OpenCodeClient(runOpenCode)),
      ),
    ).rejects.toThrow("planning phase");
    expect(runOpenCode).not.toHaveBeenCalled();
  });
});
