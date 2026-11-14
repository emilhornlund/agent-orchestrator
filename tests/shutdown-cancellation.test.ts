import { expect, it } from "vitest";
import { isShutdownCancellation } from "../src/runtime/shutdown-cancellation.js";
import {
  CommandRunAbortedError,
  CommandRunInterruptedError,
  CommandTimeoutError,
} from "../src/process/command-runner.js";
import {
  ProcessExecutionError,
  ProcessEvidenceError,
  ProcessGroupTerminationError,
} from "../src/process/process-runtime.js";

it("recognizes cancellation only after an actual shutdown request, including nested cancellation causes", () => {
  const controller = new AbortController();
  const error = new Error("workflow interrupted", {
    cause: new ProcessExecutionError("Git", "exec", "interrupted"),
  });
  expect(isShutdownCancellation(error, controller.signal)).toBe(false);
  controller.abort("signal");
  expect(isShutdownCancellation(error, controller.signal)).toBe(true);
  expect(
    isShutdownCancellation(
      new AggregateError([error, new CommandRunAbortedError()]),
      controller.signal,
    ),
  ).toBe(true);
});

it.each([
  new Error("genuine workflow failure"),
  new ProcessExecutionError("Git", "exec", "nonzero", 1),
  new ProcessExecutionError("Git", "exec", "timeout"),
  new CommandTimeoutError(1),
  new CommandRunInterruptedError("SIGKILL"),
  new ProcessGroupTerminationError(123),
  new ProcessEvidenceError("evidence failed", { cause: new CommandRunAbortedError() }),
  new AggregateError([new CommandRunAbortedError(), new Error("real failure")]),
])("does not hide a real failure or unverified stop during concurrent shutdown (%#)", (error) => {
  const controller = new AbortController();
  controller.abort("signal");
  expect(isShutdownCancellation(error, controller.signal)).toBe(false);
});
