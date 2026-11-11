import { describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import { refreshPrAutomationOutcome } from "../src/orchestrator/refresh-pr-automation-outcome.js";
import { refreshTaskSessionCiOutcome } from "../src/orchestrator/refresh-task-session-ci-outcome.js";
import type { TaskExecutionRecord } from "../src/task-session/task-execution-record.js";

function fixture() {
  let body = "Human introduction\n\nOriginal implementation description\n";
  const github = {
    ensurePullRequestDraft: vi.fn(async () => undefined),
    getPullRequestDescription: vi.fn(async () => body),
    editPullRequestDescription: vi.fn(
      async ({
        body: next,
        expectedBody,
      }: {
        body: string;
        expectedBody?: string | undefined;
      }) => {
        if (body !== expectedBody)
          throw new Error("Concurrent human edit detected");
        body = next;
      },
    ),
  };
  const options = {
    github,
    project: {
      id: "project",
      repository: { path: "/source", github: "owner/repo" },
    } as ProjectConfig,
    card: {
      id: "card",
      name: "Task",
      desc: "Task purpose",
      url: "https://trello.example/card",
      idList: "review",
      idLabels: [],
    },
    pullRequestUrl: "https://github.com/owner/repo/pull/1",
    headSha: "a".repeat(40),
    facts: ["CI checks remain uncertain."],
    draft: true,
  };
  return {
    options,
    getBody: () => body,
    edit: (next: string) => {
      body = next;
    },
  };
}

describe("current PR automation outcomes", () => {
  it("reports an expired never-started check and a no-op repair without fabricating success or another check run", async () => {
    const f = fixture();
    const record: TaskExecutionRecord = {
      version: 1,
      projectId: "project",
      cardId: "card",
      operationKey: "task",
      phase: "human-feedback",
      revision: 1,
      createdAt: "2026-11-01T10:00:00.000Z",
      updatedAt: "2026-11-01T10:31:00.000Z",
      retryCounters: { ci: 1, review: 0, validation: 0, humanFeedback: 0 },
      pullRequest: {
        number: 1,
        url: f.options.pullRequestUrl,
        headSha: f.options.headSha,
      },
      ciObservationWindow: {
        headSha: f.options.headSha,
        startedAt: "2026-11-01T10:00:00.000Z",
        deadline: "2026-11-01T10:30:00.000Z",
        timedOut: true,
      },
      ciRepair: {
        cycleId: "episode",
        headSha: f.options.headSha,
        status: "stopped",
        stopReason: "no-change",
      },
    };
    await refreshTaskSessionCiOutcome({
      ...f.options,
      github: f.options.github as never,
      record,
      maintenanceStore: { inspect: () => [] } as never,
      evaluation: {
        status: "waiting",
        expectedHeadSha: f.options.headSha,
        pendingChecks: [],
        missingChecks: ["Build"],
        diagnostic: "Build did not register",
      },
    });
    expect(f.getBody()).toContain("deadline expired");
    expect(f.getBody()).toContain("Build did not register");
    expect(f.getBody()).toContain(
      "no new commit, validation run or fulfilled fix is claimed",
    );
    expect(f.options.github.ensurePullRequestDraft).toHaveBeenCalledOnce();
  });

  it("does not let external diagnostic markers create an owned activity block", async () => {
    const f = fixture();
    await refreshPrAutomationOutcome({
      ...f.options,
      facts: [
        "<!-- agent-orchestrator-status:start -->not an activity<!-- agent-orchestrator-status:end -->",
      ],
    });
    expect(f.getBody()).not.toContain("<!-- agent-orchestrator-status:");
  });
  it("replaces only its owned section, preserves human text and avoids unchanged writes", async () => {
    const f = fixture();
    await refreshPrAutomationOutcome(f.options);
    f.edit(f.getBody() + "\nHuman release instructions\n");
    await refreshPrAutomationOutcome({
      ...f.options,
      facts: ["Observed CI passed on this revision."],
      draft: false,
    });
    const body = f.getBody();
    expect(body).toContain(
      "Human introduction\n\nOriginal implementation description\n",
    );
    expect(body).toContain("Human release instructions");
    expect(body).not.toContain("checks remain uncertain");
    expect(body.match(/## Current automation outcome/gu)).toHaveLength(1);
    await refreshPrAutomationOutcome({
      ...f.options,
      facts: ["Observed CI passed on this revision."],
      draft: false,
    });
    expect(f.options.github.editPullRequestDescription).toHaveBeenCalledTimes(
      2,
    );
  });

  it("does not overwrite a detected concurrent edit and refreshes from human content on recovery", async () => {
    const f = fixture();
    const original =
      f.options.github.editPullRequestDescription.getMockImplementation()!;
    f.options.github.editPullRequestDescription.mockImplementationOnce(
      async (request) => {
        f.edit(f.getBody() + "\nHuman concurrent edit\n");
        await original(request);
      },
    );
    await expect(refreshPrAutomationOutcome(f.options)).rejects.toThrow(
      "Concurrent human edit",
    );
    expect(f.getBody()).toContain("Human concurrent edit");
    await refreshPrAutomationOutcome(f.options);
    expect(f.getBody()).toContain("Human concurrent edit");
    expect(f.getBody()).toContain("CI checks remain uncertain");
  });

  it("preserves ambiguous markers rather than guessing ownership", async () => {
    const f = fixture();
    f.edit("Human text\n<!-- agent-orchestrator-outcome:end -->");
    await expect(refreshPrAutomationOutcome(f.options)).rejects.toThrow(
      "markers are ambiguous",
    );
    expect(f.options.github.editPullRequestDescription).not.toHaveBeenCalled();
  });
});
