import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const BASE_ENV = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  API_KEY_ENCRYPTION_KEY: "b".repeat(32),
  LIBRECHAT_BASE_URL: "http://localhost:9999",
};

// Same coercion trap as the API's LOCAL_AUTH_ENABLED (issue #125): a bare
// z.coerce.boolean() would map the string "false" to JS Boolean("false")
// === true, silently enabling profiling instead of leaving it off.
describe("loadConfig / PYROSCOPE_ENABLED (issue #185)", () => {
  it("defaults to false when unset", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.PYROSCOPE_ENABLED).toBe(false);
  });

  it('parses "false" as false, not true', () => {
    const config = loadConfig({ ...BASE_ENV, PYROSCOPE_ENABLED: "false" });
    expect(config.PYROSCOPE_ENABLED).toBe(false);
  });

  it('parses "true" as true', () => {
    const config = loadConfig({ ...BASE_ENV, PYROSCOPE_ENABLED: "true" });
    expect(config.PYROSCOPE_ENABLED).toBe(true);
  });
});
