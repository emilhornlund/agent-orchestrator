import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/global-setup.ts"],
    maxWorkers: 4,
    testTimeout: 15_000,
  },
});
