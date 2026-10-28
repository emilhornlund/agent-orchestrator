import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import {
  OpenCodeClient,
  type RunOpenCode,
} from "../src/opencode/opencode-client.js";
import {
  runTaskSessionReview,
  TaskSessionReviewUnavailableError,
  TaskSessionReviewError,
} from "../src/task-session/run-task-session-review.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { TaskPlanStore } from "../src/task-session/task-plan-store.js";
import type { TaskPlan } from "../src/task-session/task-plan.js";
import type { PlanVerificationResult } from "../src/task-session/plan-verification.js";
import type { TaskSessionValidationResult } from "../src/task-session/run-task-session-validation.js";
import type { TrelloCard } from "../src/trello/trello-client.js";
import { getTaskSessionSourceSnapshotIdentity } from "../src/task-session/source-snapshot.js";

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
  name: "Implement the requested settings feature",
  desc: "Persist settings and make them accessible.",
  idList: "ready-list",
  idLabels: ["feature-label"],
  url: "https://trello.example/card-one",
};
const expectedBranch = "agent/card-one";
const operationKey = "implementation-one";
const primarySessionId = "ses_primary-one";

const plan: TaskPlan = {
  version: 1,
  projectId,
  cardId: card.id,
  requirements: [
    {
      id: "REQ-1",
      text: "Persist the requested settings.",
      verification: "Reload persisted settings in a test.",
    },
    {
      id: "REQ-2",
      text: "Make the settings interface accessible.",
      verification: "Check accessible labels in a component test.",
    },
  ],
  steps: [
    {
      id: "STEP-1",
      description: "Implement settings UI and persistence.",
      requirementIds: ["REQ-1", "REQ-2"],
      verification: "Run settings tests.",
    },
  ],
  assumptions: [],
  blockers: [],
};

function createFixture(options: { coverageCommand?: string } = {}) {
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-task-review-"),
  );
  const repositoryPath = path.join(temporaryRoot, "repository");
  const worktreeRoot = path.join(temporaryRoot, "worktrees");
  const worktreePath = path.join(worktreeRoot, card.id);
  const storageRoot = path.join(temporaryRoot, "runtime-state");
  fs.mkdirSync(repositoryPath);
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(
    path.join(worktreePath, "src.ts"),
    "implementation\n",
    "utf8",
  );
  fs.writeFileSync(path.join(worktreePath, "new-test.ts"), "test\n", "utf8");

  const project = {
    id: projectId,
    repository: {
      path: repositoryPath,
      worktreeRoot,
      validationCommand: "yarn validate",
      ...(options.coverageCommand === undefined
        ? {}
        : { coverageCommand: options.coverageCommand }),
    },
  } as ProjectConfig;
  const taskRecordStore = new TaskExecutionStore(storageRoot, project);
  const planStore = new TaskPlanStore(storageRoot, project);
  const headSha = "a".repeat(40);
  const git = {
    getCurrentBranch: vi.fn(async () => expectedBranch),
    getHeadSha: vi.fn(async () => headSha),
    getHeadTrackedFiles: vi.fn(async () => ["src.ts"]),
    getIndexEntries: vi.fn(
      async () => "100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0\tsrc.ts\0",
    ),
    getUntrackedFiles: vi.fn(async () => ["new-test.ts"]),
    getDiff: vi.fn(async (_cwd: string, staged = false) =>
      staged ? "staged changes" : "unstaged changes",
    ),
  } as unknown as Pick<
    GitClient,
    | "getCurrentBranch"
    | "getHeadSha"
    | "getHeadTrackedFiles"
    | "getIndexEntries"
    | "getUntrackedFiles"
    | "getDiff"
  >;
  const executionIdentity = {
    version: 1 as const,
    projectId,
    cardId: card.id,
    phase: "validation" as const,
    primarySessionId,
    sessionCreationStatus: "bound" as const,
    expectedBranch,
    operationKey,
    revision: 1,
    retryCounters: {
      validation: 0,
      review: 0,
      ci: 0,
      humanFeedback: 0,
    },
    validationRepair: undefined,
    createdAt: "2026-10-24T09:00:00.000Z",
    updatedAt: "2026-10-24T09:00:00.000Z",
  };

  return {
    project,
    worktreePath,
    taskRecordStore,
    planStore,
    git,
    executionIdentity,
    createStoredPlan: async () => {
      const contentIdentity = await getTaskSessionSourceSnapshotIdentity(
        git,
        worktreePath,
      );
      taskRecordStore.create({
        ...executionIdentity,
        validationRepair: {
          cycleId: operationKey,
          status: "passed",
          evidence: {
            command: "yarn validate",
            startedAt: "2026-10-24T09:01:00.000Z",
            completedAt: "2026-10-24T09:02:00.000Z",
            exitCode: 0,
            diagnostic: "validation passed",
            contentIdentity,
          },
          ...(options.coverageCommand === undefined
            ? {}
            : {
                coverageEvidence: {
                  command: options.coverageCommand,
                  startedAt: "2026-10-24T09:02:00.000Z",
                  completedAt: "2026-10-24T09:03:00.000Z",
                  exitCode: 0,
                  diagnostic: "coverage passed",
                  contentIdentity,
                },
              }),
        },
      });
      planStore.create(plan, 1);
      planStore.storeVerification(card.id, 1, {
        version: 1,
        projectId,
        cardId: card.id,
        planRevision: 1,
        verdict: "pass",
        findings: [],
      } satisfies PlanVerificationResult);
      return contentIdentity;
    },
  };
}

function successfulQualityEvidence(
  contentIdentity: string,
  coverageCommand?: string,
): {
  validation: TaskSessionValidationResult;
  coverage: TaskSessionValidationResult | null;
} {
  return {
    validation: {
      command: "yarn validate",
      startedAt: "2026-10-24T09:01:00.000Z",
      completedAt: "2026-10-24T09:02:00.000Z",
      exitCode: 0,
      status: "passed",
      timedOut: false,
      aborted: false,
      diagnostic: "validation passed",
      contentIdentity,
    },
    coverage:
      coverageCommand === undefined
        ? null
        : {
            command: coverageCommand,
            startedAt: "2026-10-24T09:02:00.000Z",
            completedAt: "2026-10-24T09:03:00.000Z",
            exitCode: 0,
            status: "passed",
            timedOut: false,
            aborted: false,
            diagnostic: "coverage passed",
            contentIdentity,
          },
  };
}

function passingReview(contentIdentity: string) {
  return {
    version: 1,
    projectId,
    cardId: card.id,
    verdict: "pass",
    requirementAssessments: plan.requirements.map((requirement) => ({
      requirementId: requirement.id,
      status: "satisfied",
      details: "The planned behavior is implemented.",
      evidence: ["src.ts", "new-test.ts"],
    })),
    blockingFindings: [],
    reviewedContentIdentity: contentIdentity,
  };
}

function reviewOptions(
  fixture: ReturnType<typeof createFixture>,
  openCode: OpenCodeClient,
  validation: TaskSessionValidationResult,
  coverage: TaskSessionValidationResult | null = null,
) {
  return {
    project: fixture.project,
    card,
    expectedBranch,
    operationKey,
    worktreePath: fixture.worktreePath,
    taskRecordStore: fixture.taskRecordStore,
    planStore: fixture.planStore,
    git: fixture.git,
    openCode,
    validation,
    coverage,
    runOptions: {
      model: "independent-review-model",
      variant: "high",
      timeoutMilliseconds: 60_000,
      signal: new AbortController().signal,
    },
  };
}

describe("runTaskSessionReview", () => {
  it("classifies a nonzero OpenCode review exit as unavailable", async () => {
    const fixture = createFixture();
    const identity = await fixture.createStoredPlan();
    const run = vi.fn<RunOpenCode>().mockResolvedValue({
      exitCode: 1,
      output: "",
      errorOutput: "review backend unavailable",
    });
    await expect(
      runTaskSessionReview(
        reviewOptions(
          fixture,
          new OpenCodeClient(run),
          successfulQualityEvidence(identity).validation,
        ),
      ),
    ).rejects.toBeInstanceOf(TaskSessionReviewUnavailableError);
  });

  it("classifies malformed review output as unavailable after retry", async () => {
    const fixture = createFixture();
    const identity = await fixture.createStoredPlan();
    const run = vi.fn<RunOpenCode>().mockResolvedValue({
      exitCode: 0,
      output: "{broken",
      errorOutput: "",
    });
    await expect(
      runTaskSessionReview(
        reviewOptions(
          fixture,
          new OpenCodeClient(run),
          successfulQualityEvidence(identity).validation,
        ),
      ),
    ).rejects.toBeInstanceOf(TaskSessionReviewUnavailableError);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not classify source integrity failures as an unavailable AI review", async () => {
    const fixture = createFixture();
    const identity = await fixture.createStoredPlan();
    const run = vi.fn<RunOpenCode>();
    fs.writeFileSync(
      path.join(fixture.worktreePath, "src.ts"),
      "source changed after validation\\n",
    );
    await expect(
      runTaskSessionReview(
        reviewOptions(
          fixture,
          new OpenCodeClient(run),
          successfulQualityEvidence(identity).validation,
        ),
      ),
    ).rejects.toBeInstanceOf(TaskSessionReviewError);
    expect(run).not.toHaveBeenCalled();
  });

  it("independently reviews the current diff with evidence and a read-only session", async () => {
    const fixture = createFixture();
    const contentIdentity = await fixture.createStoredPlan();
    const runOpenCode = vi.fn<RunOpenCode>().mockResolvedValue({
      exitCode: 0,
      output: JSON.stringify(passingReview(contentIdentity)),
      errorOutput: "",
    });

    const result = await runTaskSessionReview(
      reviewOptions(
        fixture,
        new OpenCodeClient(runOpenCode),
        successfulQualityEvidence(contentIdentity).validation,
      ),
    );

    expect(result.review.verdict).toBe("pass");
    expect(result.contentIdentity).toBe(contentIdentity);
    expect(runOpenCode).toHaveBeenCalledOnce();
    const run = runOpenCode.mock.calls[0]?.[0];
    expect(run?.readOnly).toBe(true);
    expect(run?.sessionId).toBeUndefined();
    expect(run?.captureSessionId).toBeUndefined();
    expect(run?.prompt).toContain(card.desc);
    expect(run?.prompt).toContain("Approved plan and acceptance criteria:");
    expect(run?.prompt).toContain("staged changes");
    expect(run?.prompt).toContain("unstaged changes");
    expect(run?.prompt).toContain("new-test.ts");
    expect(run?.prompt).toContain('"content": "test\\n"');
    expect(run?.prompt).toContain("validation passed");
    expect(run?.prompt).toContain(
      "status (string enum 'satisfied' or 'unsatisfied')",
    );
    expect(run?.prompt).toContain(
      "kind (string enum 'defect', 'incomplete', or 'contract-violation')",
    );
    expect(run?.prompt).toContain(
      "explain concrete current-source evidence demonstrating why it is material and blocks",
    );
    expect(run?.prompt).toContain(
      "verify each previously reported blocking finding",
    );
    expect(run?.prompt).toContain(
      "detect material regressions introduced by remediation",
    );
    expect(run?.prompt).toContain(
      "independently reassess every approved requirement",
    );
    expect(run?.prompt).toContain(
      "sourceContentIdentity equal to the reviewed source identity",
    );
    expect(run?.prompt).toContain("unsupported hypothetical problems");
    expect(run?.prompt).toContain("do not run tests or other commands");
    expect(run?.prompt).toContain("Valid pass example:");
    expect(run?.prompt).toContain("Valid fail example:");
    expect(run?.prompt).toContain(
      "A valid 'fail' is a review verdict, not a format/parse error",
    );
    expect(fixture.taskRecordStore.read(card.id)?.phase).toBe("review");
    expect(fixture.git.getDiff).toHaveBeenCalledWith(
      fixture.worktreePath,
      true,
    );
    expect(fixture.git.getDiff).toHaveBeenCalledWith(fixture.worktreePath);
  });

  it("limits blocking findings to material defects and excludes out-of-scope preferences", async () => {
    const fixture = createFixture();
    const contentIdentity = await fixture.createStoredPlan();
    const runOpenCode = vi.fn<RunOpenCode>().mockResolvedValue({
      exitCode: 0,
      output: JSON.stringify(passingReview(contentIdentity)),
      errorOutput: "",
    });

    await runTaskSessionReview(
      reviewOptions(
        fixture,
        new OpenCodeClient(runOpenCode),
        successfulQualityEvidence(contentIdentity).validation,
      ),
    );

    const prompt = runOpenCode.mock.calls[0]?.[0].prompt;
    expect(prompt).toContain(
      "A blocking finding must be a material issue: an unsatisfied approved requirement, a demonstrable correctness defect, a violation of an applicable repository contract, or a regression introduced by this implementation.",
    );
    expect(prompt).toContain(
      "Serious demonstrable defects remain blocking even when not explicitly mentioned in the task.",
    );
    expect(prompt).toContain(
      "Do not report unrelated refactoring opportunities, stylistic preferences without an applicable contract, optional enhancements beyond approved scope, unsupported hypothetical problems, or requests to redesign an otherwise correct implementation as blocking findings.",
    );
    expect(prompt).toContain("These may not cause a failed review.");
    expect(prompt).toContain(
      "exactly these fields: version (number, exactly 1)",
    );
  });

  it("returns blocking omitted-requirement and serious-defect findings without publication", async () => {
    const fixture = createFixture();
    const contentIdentity = await fixture.createStoredPlan();
    const failReview = {
      ...passingReview(contentIdentity),
      verdict: "fail",
      requirementAssessments: plan.requirements.map((requirement, index) => ({
        requirementId: requirement.id,
        status: index === 1 ? "unsatisfied" : "satisfied",
        details:
          index === 1 ? "REQ-2 behavior is omitted." : "REQ-1 is implemented.",
        evidence: index === 1 ? [] : ["src.ts"],
      })),
      blockingFindings: [
        {
          kind: "defect",
          summary: "Settings are not persisted after reload.",
          detail:
            "Defect: settings are held only in memory. Requirement: REQ-1 requires persistence. Evidence: src.ts:12 initializes local state without reading saved data, so a reload loses the setting. Expected behavior: restore the saved setting after reload.",
          location: { filePath: "src.ts", line: 12 },
        },
      ],
    };
    const runOpenCode = vi.fn<RunOpenCode>().mockResolvedValue({
      exitCode: 0,
      output: JSON.stringify(failReview),
      errorOutput: "",
    });

    const result = await runTaskSessionReview(
      reviewOptions(
        fixture,
        new OpenCodeClient(runOpenCode),
        successfulQualityEvidence(contentIdentity).validation,
      ),
    );

    expect(result.review.verdict).toBe("fail");
    expect(result.review.blockingFindings).toHaveLength(1);
    expect(result.review.requirementAssessments[1]?.status).toBe("unsatisfied");
    expect(fixture.taskRecordStore.read(card.id)?.phase).toBe("review");
  });

  it("provides finding history and accepts evidence-backed reopened regressions", async () => {
    const fixture = createFixture();
    const contentIdentity = await fixture.createStoredPlan();
    const previousFindings = [
      {
        id: "finding-prior",
        kind: "defect" as const,
        summary: "Persistence can be bypassed",
        detail: "Prior source defect",
        sourceContentIdentity: `sha256:${"b".repeat(64)}`,
        sourceIdentities: [`sha256:${"b".repeat(64)}`],
        status: "resolved" as const,
      },
    ];
    const reopened = {
      ...passingReview(contentIdentity),
      verdict: "fail",
      blockingFindings: [
        {
          id: "finding-prior",
          sourceContentIdentity: contentIdentity,
          kind: "defect",
          summary: "Persistence defect has returned",
          detail:
            "Evidence: src.ts:8 bypasses the persisted value and reproduces the defect. Expected behavior: load the persisted value.",
          location: { filePath: "src.ts", line: 8 },
        },
      ],
      previousFindingAssessments: [
        { findingId: "finding-prior", status: "resolved" },
      ],
    };
    const runOpenCode = vi.fn<RunOpenCode>().mockResolvedValue({
      exitCode: 0,
      output: JSON.stringify(reopened),
      errorOutput: "",
    });

    const result = await runTaskSessionReview({
      ...reviewOptions(
        fixture,
        new OpenCodeClient(runOpenCode),
        successfulQualityEvidence(contentIdentity).validation,
      ),
      previousFindings,
    });

    expect(result.review.verdict).toBe("fail");
    expect(result.review.blockingFindings[0]?.id).toBe("finding-prior");
    expect(runOpenCode.mock.calls[0]?.[0].prompt).toContain(
      JSON.stringify(previousFindings, null, 2),
    );
  });

  it("rejects review when local validation evidence is missing, failed, or stale", async () => {
    const fixture = createFixture();
    const contentIdentity = await fixture.createStoredPlan();
    const runOpenCode = vi.fn<RunOpenCode>();
    const evidence = successfulQualityEvidence(contentIdentity);

    await expect(
      runTaskSessionReview(
        reviewOptions(fixture, new OpenCodeClient(runOpenCode), {
          ...evidence.validation,
          status: "failed",
          exitCode: 1,
        }),
      ),
    ).rejects.toThrow("successful local validation evidence");
    expect(runOpenCode).not.toHaveBeenCalled();

    fs.writeFileSync(
      path.join(fixture.worktreePath, "src.ts"),
      "source changed after validation\n",
      "utf8",
    );

    await expect(
      runTaskSessionReview(
        reviewOptions(
          fixture,
          new OpenCodeClient(runOpenCode),
          evidence.validation,
        ),
      ),
    ).rejects.toThrow("stale source snapshot");
    expect(runOpenCode).not.toHaveBeenCalled();
    expect(fixture.taskRecordStore.read(card.id)?.phase).toBe("validation");
  });

  it("requires configured coverage evidence before independent review", async () => {
    const fixture = createFixture({ coverageCommand: "yarn coverage" });
    const contentIdentity = await fixture.createStoredPlan();
    const runOpenCode = vi.fn<RunOpenCode>();

    await expect(
      runTaskSessionReview(
        reviewOptions(
          fixture,
          new OpenCodeClient(runOpenCode),
          successfulQualityEvidence(contentIdentity).validation,
        ),
      ),
    ).rejects.toThrow("requires successful configured coverage evidence");
    expect(runOpenCode).not.toHaveBeenCalled();
  });

  it("includes configured coverage evidence in independent review", async () => {
    const coverageCommand = "yarn coverage";
    const fixture = createFixture({ coverageCommand });
    const contentIdentity = await fixture.createStoredPlan();
    const runOpenCode = vi.fn<RunOpenCode>().mockResolvedValue({
      exitCode: 0,
      output: JSON.stringify(passingReview(contentIdentity)),
      errorOutput: "",
    });

    const result = await runTaskSessionReview(
      reviewOptions(
        fixture,
        new OpenCodeClient(runOpenCode),
        successfulQualityEvidence(contentIdentity, coverageCommand).validation,
        successfulQualityEvidence(contentIdentity, coverageCommand).coverage,
      ),
    );

    expect(result.review.verdict).toBe("pass");
    expect(runOpenCode.mock.calls[0]?.[0].prompt).toContain(coverageCommand);
    expect(runOpenCode.mock.calls[0]?.[0].prompt).toContain("coverage passed");
  });

  it("rejects malformed reviewer output while keeping publication unavailable", async () => {
    const fixture = createFixture();
    const contentIdentity = await fixture.createStoredPlan();
    const runOpenCode = vi.fn<RunOpenCode>().mockResolvedValue({
      exitCode: 0,
      output: "the implementation looks good",
      errorOutput: "",
    });

    await expect(
      runTaskSessionReview(
        reviewOptions(
          fixture,
          new OpenCodeClient(runOpenCode),
          successfulQualityEvidence(contentIdentity).validation,
        ),
      ),
    ).rejects.toBeInstanceOf(TaskSessionReviewUnavailableError);
    expect(fixture.taskRecordStore.read(card.id)?.phase).toBe("review");
    expect(runOpenCode).toHaveBeenCalledTimes(2);
    expect(runOpenCode.mock.calls[1]?.[0].prompt).toContain(
      "FORMAT-ONLY CORRECTION",
    );
    expect(runOpenCode.mock.calls.every(([options]) => options.readOnly)).toBe(
      true,
    );
  });

  it("accepts a corrected response after one format-only retry", async () => {
    const fixture = createFixture();
    const contentIdentity = await fixture.createStoredPlan();
    const runOpenCode = vi
      .fn<RunOpenCode>()
      .mockResolvedValueOnce({
        exitCode: 0,
        output: "{not json}",
        errorOutput: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        output: JSON.stringify(passingReview(contentIdentity)),
        errorOutput: "",
      });

    const result = await runTaskSessionReview(
      reviewOptions(
        fixture,
        new OpenCodeClient(runOpenCode),
        successfulQualityEvidence(contentIdentity).validation,
      ),
    );

    expect(result.review.verdict).toBe("pass");
    expect(runOpenCode).toHaveBeenCalledTimes(2);
    expect(runOpenCode.mock.calls[1]?.[0].prompt).toContain("{not json}");
    expect(runOpenCode.mock.calls.every(([options]) => options.readOnly)).toBe(
      true,
    );
  });

  it("rejects a validly-shaped response that assesses an out-of-scope requirement without retry", async () => {
    const fixture = createFixture();
    const contentIdentity = await fixture.createStoredPlan();
    const outOfScopeReview = {
      ...passingReview(contentIdentity),
      requirementAssessments: [
        {
          requirementId: "REQ-1",
          status: "satisfied",
          details: "The requested behavior is implemented.",
          evidence: ["src.ts"],
        },
        {
          requirementId: "REQ-EXTRA",
          status: "satisfied",
          details: "An unrelated behavior is implemented.",
          evidence: ["src.ts"],
        },
      ],
    };
    const runOpenCode = vi.fn<RunOpenCode>().mockResolvedValue({
      exitCode: 0,
      output: JSON.stringify(outOfScopeReview),
      errorOutput: "",
    });

    await expect(
      runTaskSessionReview(
        reviewOptions(
          fixture,
          new OpenCodeClient(runOpenCode),
          successfulQualityEvidence(contentIdentity).validation,
        ),
      ),
    ).rejects.toThrow("out-of-scope result");
    expect(runOpenCode).toHaveBeenCalledOnce();
  });

  it("rejects a source edit made during review as stale", async () => {
    const fixture = createFixture();
    const contentIdentity = await fixture.createStoredPlan();
    const runOpenCode = vi.fn<RunOpenCode>().mockImplementation(async () => {
      fs.writeFileSync(
        path.join(fixture.worktreePath, "src.ts"),
        "changed during review\n",
        "utf8",
      );
      return {
        exitCode: 0,
        output: JSON.stringify(passingReview(contentIdentity)),
        errorOutput: "",
      };
    });

    await expect(
      runTaskSessionReview(
        reviewOptions(
          fixture,
          new OpenCodeClient(runOpenCode),
          successfulQualityEvidence(contentIdentity).validation,
        ),
      ),
    ).rejects.toThrow("changed during independent implementation review");
    expect(fixture.taskRecordStore.read(card.id)?.phase).toBe("review");
  });

  it("rechecks reviewed content identity after a format-only retry", async () => {
    const fixture = createFixture();
    const contentIdentity = await fixture.createStoredPlan();
    const runOpenCode = vi
      .fn<RunOpenCode>()
      .mockResolvedValueOnce({
        exitCode: 0,
        output: "not json",
        errorOutput: "",
      })
      .mockImplementationOnce(async () => {
        fs.writeFileSync(
          path.join(fixture.worktreePath, "src.ts"),
          "changed during format retry\n",
          "utf8",
        );
        return {
          exitCode: 0,
          output: JSON.stringify(passingReview(contentIdentity)),
          errorOutput: "",
        };
      });

    await expect(
      runTaskSessionReview(
        reviewOptions(
          fixture,
          new OpenCodeClient(runOpenCode),
          successfulQualityEvidence(contentIdentity).validation,
        ),
      ),
    ).rejects.toThrow("changed during independent implementation review");
    expect(runOpenCode).toHaveBeenCalledTimes(2);
  });
});
