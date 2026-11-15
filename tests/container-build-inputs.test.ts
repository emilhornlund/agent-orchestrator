import fs from "node:fs";
import { describe, expect, it } from "vitest";

const containerfile = fs.readFileSync(new URL("../Containerfile", import.meta.url), "utf8");
// The Containerfile uses plain, whitespace-separated COPY sources. Stage copies
// are not build-context inputs and must not broaden the source allowlist.
const sources = containerfile
  .split("\n")
  .filter((line) => line.startsWith("COPY ") && !line.includes("--from="))
  .flatMap((line) => line.trim().split(/\s+/u).slice(1, -1));
const rules = (file: string) =>
  fs
    .readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

describe("container build inputs", () => {
  it.each([".dockerignore", ".containerignore"])(
    "%s includes every local COPY source without opening the context to runtime data",
    (file) => {
      const allowlist = rules(file);
      expect(allowlist[0]).toBe("**");
      expect(allowlist).not.toContain("!scripts/**");
      for (const source of sources) {
        const sourcePath = new URL(`../${source}`, import.meta.url);
        expect(fs.existsSync(sourcePath), source).toBe(true);
        expect(allowlist, `${file}: ${source}`).toContain(`!${source}`);
        if (fs.statSync(sourcePath).isDirectory())
          expect(allowlist, `${file}: ${source} descendants`).toContain(`!${source}/**`);
      }
    },
  );

  it("keeps Docker and Podman build context rules identical", () => {
    expect(rules(".dockerignore")).toEqual(rules(".containerignore"));
  });
});
