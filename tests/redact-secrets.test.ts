import { describe, expect, it } from "vitest";

import {
  createSecretRedactor,
  redactSecrets,
} from "../src/security/redact-secrets.js";

describe("secret redaction", () => {
  it("redacts literal secrets split at every chunk boundary", () => {
    const secret = "split-secret-value";
    for (let boundary = 1; boundary < secret.length; boundary += 1) {
      const redactor = createSecretRedactor([secret]);
      const output =
        redactor.push(`before ${secret.slice(0, boundary)}`) +
        redactor.push(`${secret.slice(boundary)} after`) +
        redactor.flush();
      expect(output).toBe("before [REDACTED] after");
    }
  });

  it("keeps large ordinary streams incremental", () => {
    const redactor = createSecretRedactor(["private-value"]);
    const first = redactor.push("ordinary output ".repeat(100_000));
    expect(first.length).toBeGreaterThan(1_000_000);
    expect(redactor.flush()).toBe("");
  });

  it("does not repeatedly redact existing markers when secrets are short", () => {
    expect(redactSecrets("a [REDACTED] a", ["a"])).toBe(
      "[REDACTED] [REDACTED] [REDACTED]",
    );
  });

  it("does not emit duplicate markers for overlapping credential patterns", () => {
    expect(redactSecrets("authorization: Bearer long-token")).toBe(
      "authorization: [REDACTED]",
    );
  });

  it("redacts credential values that continue across a chunk boundary", () => {
    const redactor = createSecretRedactor();
    const output =
      redactor.push("authorization: Bearer very-long-secret-") +
      redactor.push("continued\n") +
      redactor.flush();
    expect(output).toBe("authorization: [REDACTED]\n");
  });

  it("does not retain an unbounded credential value in the redactor", () => {
    const redactor = createSecretRedactor();
    const output = redactor.push(`Bearer ${"x".repeat(1_000_000)}`);
    expect(output).toBe("Bearer [REDACTED]");
    expect(
      redactor.push(`${"y".repeat(1_000_000)}, next output\n`) +
        redactor.flush(),
    ).toBe(", next output\n");
  });
});
