import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["../../vitest.dbGuard.ts"],
    // webhookDelivery.test.ts and processor.test.ts both reset the
    // *entire* shared test Postgres database in their own beforeEach —
    // running test files concurrently races one file's reset against
    // another's in-progress fixture setup (FK violations on rows that
    // just got wiped out from under it). These are integration tests
    // against one real database, not isolated units, so serialize them.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text", "json-summary"],
      // Modest floor a few points under today's numbers (56% lines,
      // 60% branches, 67% functions — issue #52): catches a large
      // untested addition without blocking normal work. Ratchet these
      // up as coverage grows; never down.
      thresholds: {
        lines: 50,
        functions: 60,
        branches: 55,
        statements: 50,
      },
    },
  },
});
