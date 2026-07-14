import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // authz.test.ts, sessionFixation.test.ts, and (previously) access.test.ts
    // all reset shared tables (users, projects, api keys, ...) in the same
    // real test Postgres database in their own beforeEach/resetDb — running
    // test files concurrently races one file's reset against another's
    // in-progress fixture setup (FK violations, or a user vanishing mid-test
    // from under a different file). These are integration tests against one
    // real database, not isolated units, so serialize them — same fix
    // already applied in packages/worker/vitest.config.ts for the identical
    // reason.
    fileParallelism: false,
  },
});
