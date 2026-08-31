import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type ActionPin = {
  repository: string;
  sha: string;
};

const expectedActionRepositories = ["actions/checkout", "actions/setup-node"];

function collectActionReferences(value: unknown, path = "workflow"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectActionReferences(item, `${path}[${index}]`),
    );
  }

  if (typeof value !== "object" || value === null) {
    return [];
  }

  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = `${path}.${key}`;

    if (key === "uses") {
      if (typeof child !== "string") {
        throw new Error(`${childPath} must be a string`);
      }

      return [child];
    }

    return collectActionReferences(child, childPath);
  });
}

function parseActionReference(reference: string, index: number): ActionPin {
  const separator = reference.lastIndexOf("@");
  const repository = reference.slice(0, separator);
  const sha = reference.slice(separator + 1);

  if (
    separator <= 0 ||
    separator === reference.length - 1 ||
    !/^[a-f0-9]{40}$/.test(sha)
  ) {
    throw new Error(
      `CI action reference ${index + 1} ("${reference}") must use ` +
        "repository@<40-character lowercase hexadecimal commit SHA>",
    );
  }

  return { repository, sha };
}

describe("CI workflow action pins", () => {
  it("uses immutable commits from the intended action repositories", () => {
    const workflow = parse(
      readFileSync(
        resolve(process.cwd(), ".github", "workflows", "ci.yml"),
        "utf8",
      ),
    );
    const references = collectActionReferences(workflow);

    expect(references).toHaveLength(expectedActionRepositories.length);

    const pins = references.map(parseActionReference);
    expect(pins.map((pin) => pin.repository)).toEqual(
      expectedActionRepositories,
    );
    expect(pins.every((pin) => /^[a-f0-9]{40}$/.test(pin.sha))).toBe(true);
  });
});
