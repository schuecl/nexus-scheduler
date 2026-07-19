import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["../../vitest.dbGuard.ts"],
    // access.test.ts, audit.test.ts, authz.test.ts, sessionFixation.test.ts,
    // routes.integration.test.ts, and promptVersionConcurrency.test.ts all
    // reset shared tables (users, projects, api keys, ...) in the same real
    // test Postgres database in their own beforeEach/resetDb — running test
    // files concurrently races one file's reset against another's
    // in-progress fixture setup (FK violations, or a row vanishing mid-test
    // from under a different file). These are integration tests against one
    // real database, not isolated units, so serialize them — same posture
    // as packages/worker/vitest.config.ts.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text", "json-summary"],
      // Modest floor a few points under today's numbers (30% lines,
      // 72% branches, 66% functions — issue #52): catches a large
      // untested addition without blocking normal work. Ratchet these
      // up as coverage grows; never down.
      thresholds: {
        lines: 25,
        functions: 60,
        branches: 65,
        statements: 25,
      },
    },
  },
});
