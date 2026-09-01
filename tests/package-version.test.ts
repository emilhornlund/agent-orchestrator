import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import {
  formatStartupEvent,
  loadStartupEvent,
} from "../src/package-version.js";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as { version: string };

describe("startup package version", () => {
  it("formats the stable root startup event with a v prefix", () => {
    expect(formatStartupEvent({ version: "1.2.3" })).toBe(
      "Agent Orchestrator v1.2.3",
    );
  });

  it("loads the version from the repository package metadata", () => {
    expect(loadStartupEvent()).toBe(
      `Agent Orchestrator v${packageMetadata.version}`,
    );
  });

  it.each([
    undefined,
    null,
    {},
    { version: "" },
    { version: "   " },
    { version: 1 },
  ])("rejects package metadata without a usable version: %j", (metadata) => {
    expect(() => loadStartupEvent(() => metadata)).toThrow(
      'Invalid package metadata: package.json must contain a non-empty string "version".',
    );
  });

  it("reports unavailable package metadata clearly", () => {
    expect(() =>
      loadStartupEvent(() => {
        throw new Error("package.json is missing");
      }),
    ).toThrow(
      "Unable to load package metadata from package.json: package.json is missing",
    );
  });
});
