import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import type { CiCheckExpectationSource } from "./ci-check-expectations.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPullRequestTrigger(on: unknown): boolean | null {
  const names = ["pull_request", "pull_request_target"];
  if (typeof on === "string") return names.includes(on);
  if (Array.isArray(on)) {
    if (!on.every((entry) => typeof entry === "string")) return null;
    return on.some((entry) => names.includes(entry));
  }
  if (!isRecord(on)) return null;
  const triggers = Object.keys(on);
  return triggers.some((trigger) => names.includes(trigger));
}

function sourceId(workflowFile: string): string {
  return `workflow:${workflowFile.split(path.sep).join("/")}`;
}

function branchPatternMatches(pattern: string, branch: string): boolean | null {
  if (pattern.length === 0) return null;
  const positivePattern = pattern.startsWith("!") ? pattern.slice(1) : pattern;
  if (positivePattern.length === 0 || positivePattern.startsWith("!"))
    return null;
  let expression = "^";
  for (let index = 0; index < positivePattern.length; index += 1) {
    const character = positivePattern[index]!;
    if (character === "*") {
      if (positivePattern[index + 1] === "*") {
        expression += ".*";
        index += 1;
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else if (character === "[") {
      const close = positivePattern.indexOf("]", index + 1);
      if (close < 0) return null;
      expression += positivePattern.slice(index, close + 1);
      index = close;
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
    }
  }
  try {
    return new RegExp(`${expression}$`, "u").test(branch);
  } catch {
    return null;
  }
}

function branchFilterMatches(
  trigger: Record<string, unknown>,
  baseBranch: string | undefined,
): boolean | null {
  const branches = trigger.branches;
  const ignored = trigger["branches-ignore"];
  if (branches === undefined && ignored === undefined) return true;
  if (baseBranch === undefined || baseBranch.length === 0) return null;
  const matchesPatterns = (
    value: unknown,
    allowNegation: boolean,
  ): boolean | null => {
    if (
      !Array.isArray(value) ||
      !value.every((entry) => typeof entry === "string")
    )
      return null;
    if (value.length === 0) return null;
    let matched = false;
    let hasPositivePattern = false;
    for (const pattern of value) {
      if (pattern.startsWith("!") && !allowNegation) return null;
      if (!pattern.startsWith("!")) hasPositivePattern = true;
      const match = branchPatternMatches(pattern, baseBranch);
      if (match === null) return null;
      if (match) matched = !pattern.startsWith("!");
    }
    if (allowNegation && !hasPositivePattern) return null;
    return matched;
  };
  if (branches !== undefined) return matchesPatterns(branches, true);
  const match = matchesPatterns(ignored, false);
  return match === null ? null : !match;
}

function uncertainWorkflow(
  id: string,
  reason: string,
  checkNames: string[] = [],
): CiCheckExpectationSource {
  return {
    kind: "workflow-contract",
    sourceId: id,
    complete: false,
    checkNames,
    uncertainty: reason,
  };
}

/** Reads repository-owned workflow contracts without executing or contacting services. */
export function collectCiWorkflowExpectationSources(
  repositoryPath: string,
  baseBranch?: string,
): CiCheckExpectationSource[] {
  const workflowsDirectory = path.join(repositoryPath, ".github", "workflows");
  const directory = fs.lstatSync(workflowsDirectory, { throwIfNoEntry: false });
  if (directory === undefined) return [];
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    return [
      uncertainWorkflow(
        "workflow-directory",
        "GitHub workflows path is not a regular directory",
      ),
    ];
  }

  const entries = fs
    .readdirSync(workflowsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/iu.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const sources: CiCheckExpectationSource[] = [];

  for (const filename of entries) {
    const filepath = path.join(workflowsDirectory, filename);
    const id = sourceId(path.join(".github", "workflows", filename));
    try {
      if (fs.lstatSync(filepath).isSymbolicLink()) {
        sources.push(uncertainWorkflow(id, "workflow file is a symbolic link"));
        continue;
      }
      const workflow: unknown = YAML.parse(fs.readFileSync(filepath, "utf8"));
      if (!isRecord(workflow)) {
        sources.push(uncertainWorkflow(id, "workflow document is malformed"));
        continue;
      }
      const pullRequestWorkflow = hasPullRequestTrigger(workflow.on);
      if (pullRequestWorkflow === false) continue;
      if (pullRequestWorkflow === null) {
        sources.push(
          uncertainWorkflow(id, "workflow trigger contract is unsupported"),
        );
        continue;
      }

      const triggers = workflow.on;
      const triggerDetails =
        isRecord(triggers) &&
        (isRecord(triggers.pull_request)
          ? triggers.pull_request
          : isRecord(triggers.pull_request_target)
            ? triggers.pull_request_target
            : undefined);
      if (triggerDetails !== undefined && triggerDetails !== false) {
        const branchMatch = branchFilterMatches(triggerDetails, baseBranch);
        if (branchMatch === false) continue;
        if (branchMatch === null) {
          sources.push(
            uncertainWorkflow(
              id,
              "pull-request branch filter is unsupported or the base branch is unavailable",
            ),
          );
          continue;
        }
        if (
          triggerDetails.paths !== undefined ||
          triggerDetails["paths-ignore"] !== undefined
        ) {
          sources.push(
            uncertainWorkflow(
              id,
              "pull-request workflow has path filters whose applicability cannot be proven from the workflow file alone",
            ),
          );
          continue;
        }
      }

      if (!isRecord(workflow.jobs) || Object.keys(workflow.jobs).length === 0) {
        sources.push(uncertainWorkflow(id, "workflow has no static jobs map"));
        continue;
      }

      const checkNames: string[] = [];
      let uncertainty: string | undefined;
      for (const [jobId, job] of Object.entries(workflow.jobs)) {
        if (!isRecord(job)) {
          uncertainty = `job ${jobId} is malformed`;
          break;
        }
        if (job.if !== undefined) {
          uncertainty = `job ${jobId} is conditional`;
          break;
        }
        if (job.strategy !== undefined) {
          uncertainty = `job ${jobId} uses a dynamic or matrix strategy`;
          break;
        }
        if (job.uses !== undefined) {
          uncertainty = `job ${jobId} calls a reusable workflow whose checks are not in this file`;
          break;
        }
        const name = job.name === undefined ? jobId : job.name;
        if (typeof name !== "string" || name.trim().length === 0) {
          uncertainty = `job ${jobId} has no static check name`;
          break;
        }
        if (name.includes("${{")) {
          uncertainty = `job ${jobId} has a dynamically interpolated check name`;
          break;
        }
        checkNames.push(name);
      }

      if (uncertainty !== undefined) {
        sources.push(uncertainWorkflow(id, uncertainty, checkNames));
      } else {
        sources.push({
          kind: "workflow-contract",
          sourceId: id,
          complete: true,
          checkNames,
        });
      }
    } catch {
      sources.push(
        uncertainWorkflow(id, "workflow file could not be parsed safely"),
      );
    }
  }

  return sources;
}
