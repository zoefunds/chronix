import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Integration tests share one Postgres instance and TRUNCATE between tests,
    // so test files must not run concurrently against it.
    fileParallelism: false,
  },
});
