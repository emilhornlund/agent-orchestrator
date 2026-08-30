import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type DependabotConfig = {
  version: unknown;
  updates: unknown;
};

type DependabotUpdate = {
  "package-ecosystem": unknown;
  directory: unknown;
  schedule: unknown;
  "open-pull-requests-limit": unknown;
  cooldown: unknown;
  ignore?: unknown;
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

function parseDependabotConfig(): DependabotConfig {
  const config = parse(
    readFileSync(resolve(process.cwd(), ".github", "dependabot.yml"), "utf8"),
  );
  const record = asRecord(config, "Dependabot configuration");

  return {
    version: record.version,
    updates: record.updates,
  };
}

function parseUpdates(value: unknown): DependabotUpdate[] {
  if (!Array.isArray(value)) {
    throw new Error("Dependabot updates must be an array");
  }

  return value.map((update, index) => {
    const record = asRecord(update, `Dependabot update ${index}`);

    return {
      "package-ecosystem": record["package-ecosystem"],
      directory: record.directory,
      schedule: record.schedule,
      "open-pull-requests-limit": record["open-pull-requests-limit"],
      cooldown: record.cooldown,
      ...(record.ignore === undefined ? {} : { ignore: record.ignore }),
    };
  });
}

describe("Dependabot configuration", () => {
  it("uses explicit cooldowns without changing update cadence or limits", () => {
    const config = parseDependabotConfig();
    const updates = parseUpdates(config.updates);

    expect(config.version).toBe(2);
    expect(updates).toHaveLength(2);

    const updatesByEcosystem = new Map(
      updates.map((update) => [update["package-ecosystem"], update]),
    );

    expect([...updatesByEcosystem.keys()]).toEqual(["npm", "github-actions"]);

    for (const ecosystem of ["npm", "github-actions"]) {
      const update = updatesByEcosystem.get(ecosystem);

      expect(update).toBeDefined();
      expect(update).toMatchObject({
        "package-ecosystem": ecosystem,
        directory: "/",
        schedule: { interval: "weekly" },
        "open-pull-requests-limit": 5,
        cooldown: { "default-days": 7 },
      });
      expect(update!.cooldown).toEqual({ "default-days": 7 });
    }

    expect(updatesByEcosystem.get("npm")!.ignore).toEqual([
      {
        "dependency-name": "@types/node",
        versions: [">=25.0.0"],
      },
    ]);
  });
});
