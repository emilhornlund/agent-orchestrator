import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { collectCiWorkflowExpectationSources } from "../src/github/ci-workflow-contract.js";

let root: string;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

function addWorkflow(name: string, content: string): void {
  const directory = path.join(root, ".github", "workflows");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, name), content);
}

describe("collectCiWorkflowExpectationSources", () => {
  it("establishes job check names from a static pull-request workflow", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ci-workflow-contract-"));
    addWorkflow(
      "ci.yml",
      [
        "name: CI",
        "on:",
        "  pull_request:",
        "    types: [opened, synchronize]",
        "jobs:",
        "  unit:",
        "    name: Unit tests",
        "    runs-on: ubuntu-latest",
        "    steps: []",
        "  lint:",
        "    runs-on: ubuntu-latest",
        "    steps: []",
      ].join("\n"),
    );

    expect(collectCiWorkflowExpectationSources(root)).toEqual([
      {
        kind: "workflow-contract",
        sourceId: "workflow:.github/workflows/ci.yml",
        complete: true,
        checkNames: ["Unit tests", "lint"],
      },
    ]);
  });

  it("ignores workflows that cannot run for pull requests", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ci-workflow-contract-"));
    addWorkflow(
      "release.yaml",
      [
        "name: Release",
        "on: workflow_dispatch",
        "jobs:",
        "  release:",
        "    steps: []",
      ].join("\n"),
    );
    expect(collectCiWorkflowExpectationSources(root)).toEqual([]);
  });

  it.each([
    [
      "conditional job",
      [],
      ["    if: github.event.pull_request.draft == false"],
    ],
    [
      "matrix job",
      [],
      ["    strategy:", "      matrix:", "        node: [20, 22]"],
    ],
    ["filtered workflow", ["    paths: [src/**]"], []],
  ])(
    "marks a %s workflow contract incomplete",
    (label, triggerExtras, jobExtras) => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), `ci-workflow-${label}-`));
      addWorkflow(
        "ci.yml",
        [
          "name: CI",
          "on:",
          "  pull_request:",
          ...triggerExtras,
          "jobs:",
          "  test:",
          ...jobExtras,
          "    runs-on: ubuntu-latest",
          "    steps: []",
        ].join("\n"),
      );
      expect(collectCiWorkflowExpectationSources(root)).toMatchObject([
        { complete: false, kind: "workflow-contract" },
      ]);
    },
  );

  it("returns no contracts when the repository has no workflow directory", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ci-workflow-contract-"));
    expect(collectCiWorkflowExpectationSources(root)).toEqual([]);
  });
});
