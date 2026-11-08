import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

let temporaryRoot: string | undefined;

afterEach(() => {
  if (temporaryRoot !== undefined) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

describe("P5 T2 scripted fresh-parent reconstruction harness", () => {
  it("verifies the production replacement-bound session before one counted primary dispatch", () => {
    const tempRoot = process.env.TMPDIR;
    if (!tempRoot) throw new Error("Set TMPDIR to workspace .p5-tmp");
    temporaryRoot = fs.mkdtempSync(path.join(tempRoot, "p5-t2-scripted-"));
    const bin = path.join(temporaryRoot, "bin");
    fs.mkdirSync(bin);
    const mockCli = path.join(bin, "opencode");
    fs.copyFileSync(
      path.join(process.cwd(), "tests/fixtures/p5-t2-scripted-opencode.js"),
      mockCli,
    );
    fs.chmodSync(mockCli, 0o755);
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/p5-t2-session-reconstruction.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          TMPDIR: tempRoot,
          P5_T2_MODEL: "offline/scripted",
          P5_T2_VARIANT: "deterministic",
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as {
      evidencePath: string;
      initialExecutions: number;
      resumedExecutions: number;
      reconstructionPrimaryExecutions: number;
      recalled: string[];
    };
    expect(summary.initialExecutions).toBe(1);
    expect(summary.resumedExecutions).toBe(1);
    expect(summary.reconstructionPrimaryExecutions).toBe(0);
    expect(summary.recalled).toEqual(
      expect.arrayContaining(["cobalt91", "lantern47"]),
    );

    const evidence = JSON.parse(
      fs.readFileSync(summary.evidencePath, "utf8"),
    ) as {
      ignoredFixtureVerified: boolean;
      untrackedFixtureStatus: string;
      baselineBefore: unknown;
      baselineAfter: unknown;
      sourceCheckoutFingerprint: unknown;
      freshParentResult: {
        replacementSessionId: string;
        reconstructionVerificationExitCode: number;
        executions: number;
        reconstructionPrimaryExecutions: number;
        baselinePreserved: boolean;
        sourceCheckoutPreserved: boolean;
        recalled: string[];
      };
    };
    const mockState = JSON.parse(
      fs.readFileSync(path.join(bin, "sessions.json"), "utf8"),
    ) as { calls: Array<{ sessionId: string; prompt: string }> };
    const replacementCalls = mockState.calls
      .filter(
        ({ sessionId }) =>
          sessionId === evidence.freshParentResult.replacementSessionId,
      )
      .map(({ prompt }) => prompt);
    const verificationIndex = replacementCalls.findIndex((prompt) =>
      prompt.includes("Summarize the available task context"),
    );
    const primaryResumeIndex = replacementCalls.findIndex((prompt) =>
      prompt.includes("What useful task facts are available"),
    );
    expect(verificationIndex).toBeGreaterThanOrEqual(0);
    expect(primaryResumeIndex).toBeGreaterThan(verificationIndex);
    const neutralPrompt = (prompt: string) =>
      prompt.split("\n\nReconstructed task context")[0]!;
    expect(neutralPrompt(replacementCalls[verificationIndex]!)).not.toContain(
      "cobalt91",
    );
    expect(neutralPrompt(replacementCalls[verificationIndex]!)).not.toContain(
      "lantern47",
    );
    expect(neutralPrompt(replacementCalls[primaryResumeIndex]!)).not.toContain(
      "cobalt91",
    );
    expect(neutralPrompt(replacementCalls[primaryResumeIndex]!)).not.toContain(
      "lantern47",
    );
    expect(evidence.ignoredFixtureVerified).toBe(true);
    expect(evidence.untrackedFixtureStatus).toContain("untracked-fixture.txt");
    expect(evidence.untrackedFixtureStatus).not.toContain(
      "preserve.ignored-fixture",
    );
    expect(evidence.baselineAfter).toEqual(evidence.baselineBefore);
    expect(evidence.sourceCheckoutFingerprint).toBeDefined();
    expect(evidence.freshParentResult.reconstructionVerificationExitCode).toBe(
      0,
    );
    expect(evidence.freshParentResult.executions).toBe(1);
    expect(evidence.freshParentResult.reconstructionPrimaryExecutions).toBe(0);
    expect(evidence.freshParentResult.baselinePreserved).toBe(true);
    expect(evidence.freshParentResult.sourceCheckoutPreserved).toBe(true);
    expect(evidence.freshParentResult.recalled).toEqual(
      expect.arrayContaining(["cobalt91", "lantern47"]),
    );
  }, 60_000);
});
