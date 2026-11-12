import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const documents = fs.globSync(["*.md", "docs/**/*.md", ".github/**/*.md"]).sort();

function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/u.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = /^#{1,6}\s+(.+)/u.exec(line)?.[1];
    if (!heading) continue;
    const slug = heading
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\-\s]/gu, "")
      .trim()
      .replace(/\s/gu, "-");
    const count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
}

describe("product documentation navigation", () => {
  it.each(documents)("keeps local links and section anchors usable in %s", (document) => {
    const content = fs.readFileSync(document, "utf8");
    const failures: string[] = [];
    for (const match of content.matchAll(/\[[^\]]+\]\(([^\s)]+)\)/gu)) {
      const href = match[1]!;
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(href)) continue;
      const [relativePath, fragment] = href.split("#");
      const target = relativePath
        ? path.resolve(path.dirname(document), decodeURIComponent(relativePath))
        : path.resolve(document);
      if (!fs.existsSync(target)) {
        failures.push(`Missing target: ${href}`);
      } else if (fragment && target.endsWith(".md")) {
        if (!headingAnchors(fs.readFileSync(target, "utf8")).has(decodeURIComponent(fragment))) {
          failures.push(`Missing section: ${href}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
