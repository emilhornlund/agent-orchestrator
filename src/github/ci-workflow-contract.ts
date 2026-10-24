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
      if (
        triggerDetails !== undefined &&
        triggerDetails !== false &&
        (triggerDetails.paths !== undefined ||
          triggerDetails["paths-ignore"] !== undefined ||
          triggerDetails.branches !== undefined ||
          triggerDetails["branches-ignore"] !== undefined)
      ) {
        sources.push(
          uncertainWorkflow(
            id,
            "pull-request workflow has path or branch filters whose applicability cannot be proven from the workflow file alone",
          ),
        );
        continue;
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
