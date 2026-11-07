import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginProcessEvidence,
  ProcessEvidenceError,
  getProcessRuntime,
  registerProcessSecrets,
} from "../src/process/process-runtime.js";
import { redactSecrets } from "../src/security/redact-secrets.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "process-runtime-test-"));
afterEach(() => vi.restoreAllMocks());

describe("process evidence failure containment", () => {
  it("registers dynamically issued project tokens for subsequent redaction", () => {
    const token = "dynamic-app-installation-token-unique";
    registerProcessSecrets([token]);
    expect(getProcessRuntime().secretValues).toContain(token);
    expect(
      redactSecrets(`response ${token}`, getProcessRuntime().secretValues),
    ).toBe("response [REDACTED]");
  });

  it("rejects initialization failure as typed error and removes partial artifacts", () => {
    const write = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() => beginProcessEvidence("cmd", root)).toThrow(
      ProcessEvidenceError,
    );
    expect(write).toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, "process-executions"))).toBe(false);
  });

  it("records append failure without throwing from stream callbacks", () => {
    const append = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    const evidence = beginProcessEvidence("cmd", root);
    expect(() => evidence.append("stdout", "output")).not.toThrow();
    expect(evidence.failure).toBeInstanceOf(ProcessEvidenceError);
    append.mockRestore();
    expect(() => evidence.finish("success")).not.toThrow();
  });

  it("throws explicit typed failure when terminal metadata cannot be written", () => {
    const evidence = beginProcessEvidence("cmd", root);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => evidence.finish("success")).toThrow(ProcessEvidenceError);
  });
});
