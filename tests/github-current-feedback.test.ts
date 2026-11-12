import { expect, it, vi } from "vitest";
import { GitHubClient, type RunGitHubCommand } from "../src/github/github-client.js";

it("collects standalone inline discussion after approval without requiring current-head changes-requested", async () => {
  const run = vi
    .fn<RunGitHubCommand>()
    .mockResolvedValueOnce(
      JSON.stringify([
        {
          number: 1,
          url: "https://github.com/owner/repo/pull/1",
          reviewDecision: "APPROVED",
          headRefOid: "new-head",
        },
      ]),
    )
    .mockResolvedValueOnce(
      JSON.stringify([
        [
          {
            id: 1,
            body: "Old request",
            state: "CHANGES_REQUESTED",
            commit_id: "old-head",
            submitted_at: "2026-10-01T00:00:00Z",
            user: { login: "human", type: "User" },
          },
          {
            id: 2,
            body: "Approved",
            state: "APPROVED",
            commit_id: "new-head",
            submitted_at: "2026-10-02T00:00:00Z",
            user: { login: "human", type: "User" },
          },
          {
            id: 3,
            body: null,
            state: "COMMENTED",
            commit_id: "old-head",
            submitted_at: "2026-10-03T00:00:00Z",
            user: { login: "other-human", type: "User" },
          },
        ],
      ]),
    )
    .mockResolvedValueOnce(
      JSON.stringify([
        [
          {
            id: 30,
            pull_request_review_id: 3,
            body: "Please handle null input",
            user: { login: "other-human", type: "User" },
            path: "src.ts",
            line: 4,
            original_line: 3,
            diff_hunk: "@@ context",
          },
        ],
      ]),
    )
    .mockResolvedValueOnce(
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "thread",
                    isResolved: false,
                    isOutdated: false,
                    comments: {
                      nodes: [
                        {
                          databaseId: 30,
                          body: "Please handle null input",
                          author: { login: "other-human", __typename: "User" },
                          path: "src.ts",
                          line: 4,
                          originalLine: 3,
                          diffHunk: "@@ context",
                          pullRequestReview: { databaseId: 3 },
                        },
                      ],
                      pageInfo: { hasNextPage: false },
                    },
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      }),
    );
  const feedback = await new GitHubClient(run).findChangesRequestedPullRequest(
    {
      cwd: "/repo",
      repository: "owner/repo",
      headBranch: "agent/card",
      baseBranch: "main",
    },
    true,
  );
  expect(feedback?.feedback.reviews).toMatchObject([
    { id: 1, body: null },
    { id: 2, body: "Approved" },
    {
      id: 3,
      inlineComments: [
        {
          id: 30,
          path: "src.ts",
          line: 4,
          originalLine: 3,
          diffHunk: "@@ context",
          threadId: "thread",
          authorIsBot: false,
        },
      ],
    },
  ]);
});

it("retains Bot actor identity at the REST comment boundary", async () => {
  const run = vi.fn<RunGitHubCommand>().mockResolvedValue(
    JSON.stringify([
      [
        {
          id: 1,
          user: { login: "service[bot]", type: "Bot" },
          body: "status",
          created_at: "2026-10-01T00:00:00Z",
          updated_at: null,
        },
      ],
    ]),
  );
  const comments = await new GitHubClient(run).getPullRequestConversationComments({
    cwd: "/repo",
    repository: "owner/repo",
    pullRequestUrl: "https://github.com/Owner/Repo/pull/1",
  });
  expect(comments[0]).toMatchObject({
    author: "service[bot]",
    authorIsBot: true,
  });
});
