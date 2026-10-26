import { describe, expect, it } from "vitest";
import { haveEquivalentImplementationChanges } from "../src/git/implementation-change-equivalence.js";

describe("haveEquivalentImplementationChanges", () => {
  const original = [
    "diff --git a/src/task.ts b/src/task.ts",
    "index 1111111..2222222 100644",
    "--- a/src/task.ts",
    "+++ b/src/task.ts",
    "@@ -12,2 +12,3 @@",
    "-const status = 'old';",
    "+const status = 'recovered';",
    "+const ready = true;",
    "",
  ].join("\n");

  it("accepts patch-equivalent changes with rebased hunk positions and new commit identities", () => {
    const rebasedOrSquashed = original
      .replace("1111111..2222222", "abcdef0..1234567")
      .replace("@@ -12,2 +12,3 @@", "@@ -104,2 +104,3 @@");
    expect(
      haveEquivalentImplementationChanges(original, rebasedOrSquashed),
    ).toBe(true);
  });

  it("rejects changed, absent, or ambiguous patch evidence", () => {
    expect(
      haveEquivalentImplementationChanges(
        original,
        original.replace("recovered", "different"),
      ),
    ).toBe(false);
    expect(haveEquivalentImplementationChanges(original, "")).toBe(false);
    expect(
      haveEquivalentImplementationChanges(
        original,
        original.replace("index 1111111..2222222 100644", "GIT binary patch"),
      ),
    ).toBe(false);
  });
});
