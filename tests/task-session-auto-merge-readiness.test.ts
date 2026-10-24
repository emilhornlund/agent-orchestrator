import { describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import type {
  GitHubClient,
  RequiredCheckObservation,
} from "../src/github/github-client.js";
import { mergeTaskSessionPullRequest } from "../src/orchestrator/merge-task-session-pull-request.js";
import { decideTaskSessionAutoMergeReadiness } from "../src/task-session/task-session-auto-merge-readiness.js";
import type { VerifiedPublicationDecisionInput } from "../src/task-session/verified-publication-decision.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

const sha = "a".repeat(40);
const content = `sha256:${"b".repeat(64)}`;
const evidence: VerifiedPublicationDecisionInput = {
  currentContentIdentity: content,
  validationCommand: "yarn validate",
  validation: {
    command: "yarn validate",
    startedAt: "2026-10-24T09:00:00.000Z",
    completedAt: "2026-10-24T09:01:00.000Z",
    exitCode: 0,
    status: "passed",
    timedOut: false,
    aborted: false,
    diagnostic: "ok",
    contentIdentity: content,
  },
  coverage: null,
  review: {
    version: 1,
    projectId: "p",
    cardId: "c",
    verdict: "pass",
    requirementAssessments: [
      {
        requirementId: "R1",
        status: "satisfied",
        details: "Done",
        evidence: ["source"],
      },
    ],
    blockingFindings: [],
    reviewedContentIdentity: content,
  },
};
const check = (
  status: RequiredCheckObservation["status"],
  headSha = sha,
): RequiredCheckObservation => ({
  name: "Build",
  headSha,
  status,
  conclusion: status === "succeeded" ? "success" : null,
  diagnostic: "",
});
const base = {
  expectedHeadSha: sha,
  observedHeadSha: sha,
  requiredCheckNames: ["Build"],
  checks: [check("succeeded")],
  localEvidence: evidence,
};

describe("task-session auto-merge readiness", () => {
  it("allows fully verified exact-head readiness and blocks non-green states", () => {
    expect(decideTaskSessionAutoMergeReadiness(base).allowed).toBe(true);
    for (const status of [
      "missing",
      "queued",
      "in_progress",
      "failed",
      "cancelled",
      "incomplete",
    ] as const) {
      expect(
        decideTaskSessionAutoMergeReadiness({
          ...base,
          checks: [check(status)],
        }).allowed,
      ).toBe(false);
    }
    expect(
      decideTaskSessionAutoMergeReadiness({
        ...base,
        observedHeadSha: "c".repeat(40),
      }).allowed,
    ).toBe(false);
    expect(
      decideTaskSessionAutoMergeReadiness({
        ...base,
        checks: [check("succeeded", "c".repeat(40))],
      }).allowed,
    ).toBe(false);
  });

  it("requires current local quality evidence and prevents merge calls when denied", async () => {
    const github = {
      mergePullRequest: vi.fn(async () => undefined),
    } as unknown as GitHubClient;
    const project = {
      id: "p",
      autoMerge: true,
      executionMode: "task-session",
      repository: { github: "o/r" },
    } as ProjectConfig;
    await expect(
      mergeTaskSessionPullRequest(
        github,
        project,
        { id: "c" } as TrelloCard,
        "https://github.com/o/r/pull/1",
        sha,
        "/repo",
        { ...base, localEvidence: { ...evidence, review: null } },
      ),
    ).rejects.toThrow("final implementation review is missing");
    expect(github.mergePullRequest).not.toHaveBeenCalled();
    await mergeTaskSessionPullRequest(
      github,
      project,
      { id: "c" } as TrelloCard,
      "https://github.com/o/r/pull/1",
      sha,
      "/repo",
      base,
    );
    expect(github.mergePullRequest).toHaveBeenCalledOnce();
  });
});
