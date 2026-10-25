import type { CiCheckExpectationDecision } from "./ci-check-expectations.js";
import type { CiCheckObservation } from "./github-client.js";

export type CiCheckEvaluation =
  | {
      status: "waiting";
      expectedHeadSha: string;
      missingChecks: string[];
      pendingChecks: string[];
      diagnostic: string;
    }
  | {
      status: "passed";
      expectedHeadSha: string;
      expectedCheckNames: string[];
    }
  | {
      status: "failed";
      expectedHeadSha: string;
      expectedCheckNames: string[];
      failures: CiCheckObservation[];
    }
  | {
      status: "uncertain";
      expectedHeadSha: string;
      observedHeadSha: string;
      expectedCheckNames: string[];
      diagnostic: string;
    };

interface CheckDisposition {
  kind: "passed" | "failed" | "pending" | "uncertain";
  check: CiCheckObservation;
  diagnostic?: string;
}

function isSha(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(value);
}

function checkName(check: CiCheckObservation): string {
  return check.source === "check-run" ? check.name : check.context;
}

function classify(check: CiCheckObservation): CheckDisposition {
  if (check.source === "check-run") {
    if (check.status === "queued" || check.status === "in_progress") {
      return { kind: "pending", check };
    }
    if (check.status !== "completed" || check.conclusion === null) {
      return {
        kind: "uncertain",
        check,
        diagnostic: `Check run ${check.name} is incomplete (${check.status}/${check.conclusion ?? "no conclusion"})`,
      };
    }
    if (check.conclusion === "success") return { kind: "passed", check };
    if (
      ["failure", "timed_out", "action_required", "startup_failure"].includes(
        check.conclusion,
      )
    ) {
      return { kind: "failed", check };
    }
    if (["cancelled", "skipped", "neutral"].includes(check.conclusion)) {
      return {
        kind: "uncertain",
        check,
        diagnostic: `Check run ${check.name} concluded ${check.conclusion}`,
      };
    }
    return {
      kind: "uncertain",
      check,
      diagnostic: `Check run ${check.name} has unsupported conclusion ${check.conclusion}`,
    };
  }

  if (check.state === "pending") return { kind: "pending", check };
  if (check.state === "success") return { kind: "passed", check };
  if (check.state === "failure" || check.state === "error") {
    return { kind: "failed", check };
  }
  return {
    kind: "uncertain",
    check,
    diagnostic: `Commit status ${check.context} has unsupported state ${check.state}`,
  };
}

/** Fails closed unless an exact-head, complete expected set is fully terminal. */
export function evaluateCiChecks(input: {
  expectedHeadSha: string;
  observedHeadSha: string;
  expectations: CiCheckExpectationDecision;
  checks: readonly CiCheckObservation[];
}): CiCheckEvaluation {
  const expectedNames =
    input.expectations.expectedCheckNames.length > 0
      ? [...new Set(input.expectations.expectedCheckNames)].sort((a, b) =>
          a.localeCompare(b),
        )
      : [];

  if (
    !isSha(input.expectedHeadSha) ||
    !isSha(input.observedHeadSha) ||
    input.observedHeadSha !== input.expectedHeadSha
  ) {
    return {
      status: "uncertain",
      expectedHeadSha: input.expectedHeadSha,
      observedHeadSha: input.observedHeadSha,
      expectedCheckNames: expectedNames,
      diagnostic: "CI evidence does not match the current expected PR head",
    };
  }

  if (input.expectations.status !== "complete") {
    return {
      status: "uncertain",
      expectedHeadSha: input.expectedHeadSha,
      observedHeadSha: input.observedHeadSha,
      expectedCheckNames: expectedNames,
      diagnostic: input.expectations.diagnostic,
    };
  }

  if (expectedNames.length === 0) {
    return {
      status: "uncertain",
      expectedHeadSha: input.expectedHeadSha,
      observedHeadSha: input.observedHeadSha,
      expectedCheckNames: [],
      diagnostic: "Complete CI expectations contained no checks",
    };
  }

  if (input.checks.some((check) => check.headSha !== input.expectedHeadSha)) {
    return {
      status: "uncertain",
      expectedHeadSha: input.expectedHeadSha,
      observedHeadSha: input.observedHeadSha,
      expectedCheckNames: expectedNames,
      diagnostic:
        "A check or commit status observation belongs to a stale PR head",
    };
  }

  const dispositions = input.checks
    .filter(
      (check) =>
        !(
          check.source === "check-run" &&
          check.status === "completed" &&
          check.conclusion === "skipped" &&
          !expectedNames.includes(checkName(check))
        ),
    )
    .map(classify);
  const uncertainChecks = dispositions.filter(
    ({ kind }) => kind === "uncertain",
  );
  if (uncertainChecks.length > 0) {
    return {
      status: "uncertain",
      expectedHeadSha: input.expectedHeadSha,
      observedHeadSha: input.observedHeadSha,
      expectedCheckNames: expectedNames,
      diagnostic: uncertainChecks
        .map(({ diagnostic }) => diagnostic ?? "A CI result is inconclusive")
        .join("; "),
    };
  }

  const missingChecks: string[] = [];
  const pendingChecks: string[] = [];
  const failures: CiCheckObservation[] = [];
  for (const name of expectedNames) {
    const matching = dispositions.filter(
      ({ check }) => checkName(check) === name,
    );
    if (matching.length === 0) {
      missingChecks.push(name);
      continue;
    }
    if (matching.some(({ kind }) => kind === "pending")) {
      pendingChecks.push(name);
      continue;
    }
    failures.push(
      ...matching
        .filter(({ kind }) => kind === "failed")
        .map(({ check }) => check),
    );
    if (
      matching.every(({ kind }) => kind === "passed") &&
      !matching.some(({ kind }) => kind === "failed")
    ) {
      continue;
    }
  }

  if (missingChecks.length > 0 || pendingChecks.length > 0) {
    return {
      status: "waiting",
      expectedHeadSha: input.expectedHeadSha,
      missingChecks,
      pendingChecks,
      diagnostic: [
        ...(missingChecks.length > 0
          ? [`Checks have not appeared: ${missingChecks.join(", ")}`]
          : []),
        ...(pendingChecks.length > 0
          ? [`Checks are still pending: ${pendingChecks.join(", ")}`]
          : []),
      ].join("; "),
    };
  }

  if (failures.length > 0) {
    return {
      status: "failed",
      expectedHeadSha: input.expectedHeadSha,
      expectedCheckNames: expectedNames,
      failures,
    };
  }

  return {
    status: "passed",
    expectedHeadSha: input.expectedHeadSha,
    expectedCheckNames: expectedNames,
  };
}
