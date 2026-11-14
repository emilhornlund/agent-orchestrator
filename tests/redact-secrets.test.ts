import { describe, expect, it } from "vitest";

import { createSecretRedactor, redactSecrets } from "../src/security/redact-secrets.js";

describe("secret redaction", () => {
  it.each([
    { output: 'parseConfig("secret: [sensitive-config-value", { suppressWarnings: true })' },
    { output: "https://example.test/?token=sensitive-query-value" },
    {
      output:
        "https://example.test/?token=sensitive-query-value,sensitive-tail;sensitive-more}sensitive-end",
    },
    { output: "Bearer sensitive-bearer-value" },
    { token: "sensitive-token-value\\" },
    { output: 'password=sensitive-password-value\\\\" after' },
  ])(
    "preserves serialized quote boundaries while redacting credentials across every split (%#)",
    (value) => {
      const input = JSON.stringify({ type: "tool_use", value, after: "retained" });
      expect(() => JSON.parse(redactSecrets(input))).not.toThrow();
      for (let boundary = 0; boundary <= input.length; boundary++) {
        const redactor = createSecretRedactor();
        const output =
          redactor.push(input.slice(0, boundary)) +
          redactor.push(input.slice(boundary)) +
          redactor.flush();
        expect(output, `split ${boundary}`).not.toMatch(/sensitive-[a-z-]+/u);
        expect(JSON.parse(output), `split ${boundary}`).toMatchObject({
          type: "tool_use",
          after: "retained",
        });
      }
    },
  );
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

  it("does not emit a complete secret on push before flush", () => {
    const redactor = createSecretRedactor(["canary-canary"]);
    expect(redactor.push("canary-canary")).not.toContain("canary-canary");
    expect(redactor.flush()).not.toContain("canary-canary");
  });

  it("streams substantial prefixes while retaining only a pending base64 padding suffix", () => {
    const secret = "reserved /+? & value";
    const encoded = Buffer.from(secret).toString("base64");
    const unpadded = encoded.replace(/=+$/u, "");
    const padding = encoded.slice(unpadded.length);
    const redactor = createSecretRedactor([secret]);
    const firstPrefix = "ordinary prefix one ".repeat(2_000);
    const secondPrefix = "ordinary prefix two ".repeat(2_000);
    expect(redactor.push(firstPrefix)).toBe(firstPrefix);
    const beforePadding = redactor.push(`${secondPrefix}${unpadded}`);
    expect(beforePadding).toBe(secondPrefix);
    expect(beforePadding.length).toBeGreaterThan(10_000);
    let streamed = firstPrefix + beforePadding;
    for (const character of padding) {
      const chunk = redactor.push(character);
      expect(chunk).not.toContain("=");
      streamed += chunk;
    }
    streamed += redactor.flush();
    expect(streamed).toBe(`${firstPrefix}${secondPrefix}[REDACTED]`);
  });

  it("redacts repeated-prefix and encoded secrets at every chunk boundary", () => {
    const secrets = ["abababab", "prefix-prefix-secret"];
    for (const secret of secrets) {
      const forms = [
        secret,
        encodeURIComponent(secret),
        Buffer.from(secret).toString("base64"),
        Buffer.from(secret).toString("base64url"),
        JSON.stringify(secret).slice(1, -1),
      ];
      for (const form of forms) {
        for (let boundary = 0; boundary <= form.length; boundary += 1) {
          const redactor = createSecretRedactor([secret]);
          const output =
            redactor.push(form.slice(0, boundary)) +
            redactor.push(form.slice(boundary)) +
            redactor.flush();
          expect(output).not.toContain(form);
          expect(output).not.toContain(secret);
        }
      }
    }
  });

  it("redacts percent/form, base64url and JSON escaped forms across every split", () => {
    const secret = 'p@ss/word" line\n';
    const forms = [
      encodeURIComponent(secret),
      new URLSearchParams({ value: secret }).toString().slice("value=".length),
      Buffer.from(secret).toString("base64"),
      Buffer.from(secret).toString("base64url"),
      JSON.stringify(secret).slice(1, -1),
    ];
    for (const form of forms) {
      expect(redactSecrets(form, [secret])).toBe("[REDACTED]");
      for (let boundary = 0; boundary <= form.length; boundary += 1) {
        const redactor = createSecretRedactor([secret]);
        const result =
          redactor.push(form.slice(0, boundary)) +
          redactor.push(form.slice(boundary)) +
          redactor.flush();
        expect(result, `${JSON.stringify(form)} split at ${boundary}`).toBe("[REDACTED]");
      }
    }
  });

  it("keeps large ordinary streams incremental", () => {
    const redactor = createSecretRedactor(["private-value"]);
    const first = redactor.push("ordinary output ".repeat(100_000));
    expect(first.length).toBeGreaterThan(1_000_000);
    expect(redactor.flush()).toBe("");
  });

  it("does not repeatedly redact existing markers when secrets are short", () => {
    expect(redactSecrets("a [REDACTED] a", ["a"])).toBe("[REDACTED] [REDACTED] [REDACTED]");
  });

  it("does not emit duplicate markers for overlapping credential patterns", () => {
    expect(redactSecrets("authorization: Bearer long-token")).toBe("authorization: [REDACTED]");
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
    expect(redactor.push(`${"y".repeat(1_000_000)}, next output\n`) + redactor.flush()).toBe(
      ", next output\n",
    );
  });
});
