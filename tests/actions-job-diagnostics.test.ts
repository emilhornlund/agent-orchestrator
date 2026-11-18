import { expect, it } from "vitest";
import {
  actionsJobIdentity,
  actionsFailureExcerpt,
} from "../src/github/actions-job-diagnostics.js";

it("selects only exact-repository GitHub Actions job URLs", () => {
  expect(
    actionsJobIdentity("https://github.com/owner/repo/actions/runs/12/job/34?pr=7", "owner/repo"),
  ).toEqual({ runId: 12, jobId: 34 });
  for (const url of [
    null,
    "bad",
    "https://other.example/owner/repo/actions/runs/12/job/34",
    "https://github.com/other/repo/actions/runs/12/job/34",
    "https://user@github.com/owner/repo/actions/runs/12/job/34",
    "http://github.com/owner/repo/actions/runs/12/job/34",
    "https://github.com/owner/repo/actions/runs/12/job/0",
    "https://github.com/owner/repo/actions/runs/12/job/9007199254740992",
    "https://github.com/owner/repo/runs/34",
  ])
    expect(actionsJobIdentity(url, "owner/repo")).toBeNull();
});

it("retains Playwright assertions instead of setup and post-job cleanup noise", () => {
  const log = [
    "setup noise\n".repeat(2000),
    "2026-11-18T05:19:40.047Z   1) [chromium] › GameJoinAvatar.spec.ts:15 › account design",
    "2026-11-18T05:19:40.048Z     Error: locator.fill: Test timeout of 60000ms exceeded.",
    "2026-11-18T05:19:40.048Z       - waiting for getByPlaceholder('Game PIN')",
    "2026-11-18T05:19:40.048Z       at GameJoinAvatar.spec.ts:197:49",
    "Post job cleanup.\n".repeat(2000),
  ].join("\n");
  const excerpt = actionsFailureExcerpt(log);
  expect(excerpt).toContain("GameJoinAvatar.spec.ts:197");
  expect(excerpt).toContain("getByPlaceholder('Game PIN')");
  expect(excerpt.match(/setup noise/gu)?.length ?? 0).toBeLessThanOrEqual(2);
  expect(excerpt.length).toBeLessThanOrEqual(12_000);
});

it("bounds logs without recognized failures and strips terminal control sequences", () => {
  const excerpt = actionsFailureExcerpt(
    "setup\n".repeat(1000) + "\u001b[31mError: assertion failed\u001b[0m\n",
  );
  expect(excerpt).toContain("Error: assertion failed");
  expect(excerpt).not.toContain("\u001b");
  expect(actionsFailureExcerpt("x".repeat(20_000))).toHaveLength(12_000);
});
