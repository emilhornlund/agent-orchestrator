import { describe, expect, it } from "vitest";

import { establishCiCheckExpectations } from "../src/github/ci-check-expectations.js";

describe("establishCiCheckExpectations", () => {
  it("combines complete repository policy and workflow contracts", () => {
    expect(
      establishCiCheckExpectations([
        {
          kind: "repository-rules",
          sourceId: "default-branch-protection",
          complete: true,
          checkNames: ["Build", "Tests"],
        },
        {
          kind: "workflow-contract",
          sourceId: "ci.yml:lint",
          complete: true,
          checkNames: ["Lint", "Build"],
        },
      ]),
    ).toEqual({
      status: "complete",
      expectedCheckNames: ["Build", "Lint", "Tests"],
      sources: ["ci.yml:lint", "default-branch-protection"],
    });
  });

  it.each([
    ["no sources", []],
    [
      "an empty policy",
      [
        {
          kind: "repository-rules",
          sourceId: "rules",
          complete: true,
          checkNames: [],
        },
      ],
    ],
    [
      "a conditional workflow",
      [
        {
          kind: "workflow-contract",
          sourceId: "ci.yml",
          complete: false,
          checkNames: ["Build"],
          uncertainty: "workflow has a conditional job",
        },
      ],
    ],
    [
      "unsupported sources",
      [
        {
          kind: "visible-check-runs",
          sourceId: "observed",
          complete: true,
          checkNames: ["Build"],
        },
      ],
    ],
    [
      "malformed sources",
      [
        {
          kind: "repository-rules",
          sourceId: "rules",
          complete: true,
          checkNames: [3],
        },
      ],
    ],
  ])("fails closed for %s", (_label, sources) => {
    expect(establishCiCheckExpectations(sources).status).toBe("uncertain");
  });

  it("does not report completeness when one of several sources is incomplete", () => {
    expect(
      establishCiCheckExpectations([
        {
          kind: "repository-rules",
          sourceId: "rules",
          complete: true,
          checkNames: ["Build"],
        },
        {
          kind: "workflow-contract",
          sourceId: "dynamic-matrix",
          complete: false,
          checkNames: ["Tests"],
          uncertainty: "matrix expands from runtime input",
        },
      ]),
    ).toMatchObject({
      status: "uncertain",
      expectedCheckNames: ["Build", "Tests"],
      diagnostic: expect.stringContaining("matrix expands from runtime input"),
    });
  });

  it("rejects duplicate names within a source and duplicate source identity", () => {
    expect(
      establishCiCheckExpectations([
        {
          kind: "repository-rules",
          sourceId: "rules",
          complete: true,
          checkNames: ["Build", "Build"],
        },
      ]),
    ).toMatchObject({
      status: "uncertain",
      diagnostic: expect.stringContaining("duplicate check names"),
    });

    expect(
      establishCiCheckExpectations([
        {
          kind: "repository-rules",
          sourceId: "same",
          complete: true,
          checkNames: ["Build"],
        },
        {
          kind: "workflow-contract",
          sourceId: "same",
          complete: true,
          checkNames: ["Tests"],
        },
      ]),
    ).toMatchObject({
      status: "uncertain",
      diagnostic: expect.stringContaining("identities are duplicated"),
    });
  });
});
