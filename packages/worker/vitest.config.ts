import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // webhookDelivery.test.ts and processor.test.ts both reset the
    // *entire* shared test Postgres database in their own beforeEach —
    // running test files concurrently races one file's reset against
    // another's in-progress fixture setup (FK violations on rows that
    // just got wiped out from under it). These are integration tests
    // against one real database, not isolated units, so serialize them.
    fileParallelism: false,
  },
});
