import { EventEmitter } from "node:events";

/** Supply the private supervisor protocol for mocked native child processes. */
export function attachContainedChildStatus<T extends EventEmitter>(
  child: T,
): T & { stdio: (EventEmitter | null)[] } {
  const status = new EventEmitter();
  const result = Object.assign(child, { stdio: [null, null, null, status, null] });
  child.prependListener("close", (code: number | null, signal?: NodeJS.Signals | null) => {
    status.emit(
      "data",
      `${JSON.stringify({ type: "started" })}\n${JSON.stringify({ type: "result", spawned: true, code: code ?? null, signal: signal ?? null })}\n`,
    );
  });
  return result;
}
