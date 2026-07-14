import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
  },
});
