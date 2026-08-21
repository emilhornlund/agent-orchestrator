import { describe, expect, it } from "vitest";
import { parseEnvironment } from "../src/config/environment.js";

describe("parseEnvironment", () => {
  it("accepts valid environment variables", () => {
    const environment = parseEnvironment({
      TRELLO_API_KEY: "api-key",
      TRELLO_TOKEN: "token",
    });

    expect(environment.TRELLO_API_KEY).toBe("api-key");
    expect(environment.TRELLO_TOKEN).toBe("token");
  });

  it("rejects a missing Trello API key", () => {
    expect(() =>
      parseEnvironment({
        TRELLO_TOKEN: "token",
      }),
    ).toThrow("TRELLO_API_KEY is required");
  });

  it("rejects a missing Trello token", () => {
    expect(() =>
      parseEnvironment({
        TRELLO_API_KEY: "api-key",
      }),
    ).toThrow("TRELLO_TOKEN is required");
  });

  it("does not include secret values in validation errors", () => {
    const secret = "super-secret-token-value";

    try {
      parseEnvironment({
        TRELLO_API_KEY: "",
        TRELLO_TOKEN: secret,
      });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
