import { createHash } from "node:crypto";
import console from "node:console";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const classifications = [
  "Compliant",
  "Partially compliant",
  "Noncompliant",
  "Unverified",
  "Needs clarification",
];

// Deliberately fail on unsupported structure rather than silently dropping criteria.
export function inventory(requirements, specification) {
  const statements = [];
  const criteria = [];
  const ids = [];
  let section = "";
  let requirement;
  let acceptance = false;
  let previous;
  for (const [index, line] of requirements.split("\n").entries()) {
    if (line.startsWith("## ")) section = line.slice(3);
    if (line.startsWith("- ")) {
      previous = {
        key: `requirements:L${index + 1}`,
        section,
        line: index + 1,
        text: line.slice(2),
      };
      statements.push(previous);
    } else if (/^ {2}\S/.test(line) && previous) previous.text += ` ${line.trim()}`;
    else previous = undefined;
  }
  previous = undefined;
  for (const [index, line] of specification.split("\n").entries()) {
    const heading = /^### (REQ-[A-Z]+-\d{3}) — (.+)$/.exec(line);
    if (heading) {
      if (requirement && !criteria.some((row) => row.id === requirement))
        throw new Error(`No acceptance criteria for ${requirement}`);
      requirement = heading[1];
      if (ids.includes(requirement)) throw new Error(`Duplicate ID ${requirement}`);
      ids.push(requirement);
      acceptance = false;
    } else if (/^#{1,3} /.test(line)) {
      if (requirement && !criteria.some((row) => row.id === requirement))
        throw new Error(`No acceptance criteria for ${requirement}`);
      requirement = undefined;
      acceptance = false;
    }
    if (/^### REQ-/.test(line) && !heading)
      throw new Error(`Unsupported ID heading at ${index + 1}`);
    if (line === "**Acceptance criteria**") {
      if (!requirement || acceptance) throw new Error(`Unexpected criteria marker at ${index + 1}`);
      acceptance = true;
    }
    if (requirement && acceptance && line.startsWith("- ")) {
      const ordinal = criteria.filter((row) => row.id === requirement).length + 1;
      previous = {
        key: `${requirement}/AC-${String(ordinal).padStart(2, "0")}`,
        id: requirement,
        line: index + 1,
        text: line.slice(2),
      };
      criteria.push(previous);
    } else if (/^ {2}\S/.test(line) && previous) previous.text += ` ${line.trim()}`;
    else previous = undefined;
    if (requirement && acceptance && /^\s*(?:\d+[.)]|[+*])\s/.test(line))
      throw new Error(`Unsupported criterion list at ${index + 1}`);
  }
  if (requirement && !criteria.some((row) => row.id === requirement))
    throw new Error(`No acceptance criteria for ${requirement}`);
  if (!ids.length || !statements.length)
    throw new Error("Empty requirements or specification inventory");
  return {
    hashes: {
      requirements: createHash("sha256").update(requirements).digest("hex"),
      specification: createHash("sha256").update(specification).digest("hex"),
    },
    ids,
    statements,
    criteria,
  };
}

export function checkCoverage(expected, matrix) {
  if (!Array.isArray(matrix)) throw new Error("Matrix must be an array");
  const seen = new Set();
  for (const row of matrix) {
    if (!row || !expected.criteria.some((criterion) => criterion.key === row.key))
      throw new Error(`Unknown criterion ${row?.key}`);
    if (seen.has(row.key)) throw new Error(`Duplicate criterion ${row.key}`);
    seen.add(row.key);
    if (!classifications.includes(row.status)) throw new Error(`Invalid status for ${row.key}`);
    for (const field of ["rationale", "production", "tests", "evidence", "gaps"]) {
      if (typeof row[field] !== "string" || !row[field].trim())
        throw new Error(`Missing ${field} for ${row.key}`);
    }
    if (!Array.isArray(row.findings)) throw new Error(`Missing findings list for ${row.key}`);
  }
  const missing = expected.criteria.filter((row) => !seen.has(row.key));
  if (missing.length)
    throw new Error(`Missing criteria: ${missing.map((row) => row.key).join(", ")}`);
  return { ids: expected.ids.length, criteria: seen.size };
}

async function main() {
  const expected = inventory(
    await readFile("docs/requirements.md", "utf8"),
    await readFile("docs/specification.md", "utf8"),
  );
  const [command, file] = process.argv.slice(2);
  if (command === "inventory" && !file) console.log(JSON.stringify(expected, null, 2));
  else if (command === "check" && file) {
    console.log(JSON.stringify(checkCoverage(expected, JSON.parse(await readFile(file, "utf8")))));
  } else throw new Error("Usage: node scripts/spec-audit.mjs inventory | check <matrix.json>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
