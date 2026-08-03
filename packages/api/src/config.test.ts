import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";

// Regression test for issue #125: LOCAL_AUTH_ENABLED used z.coerce.boolean(),
// which runs JS Boolean() on the raw env string — Boolean("false") === true,
// so LOCAL_AUTH_ENABLED=false silently left local auth *on*. Security-relevant
// for an auth-gating flag, so it's asserted explicitly rather than left to
// whatever the other config tests happen to cover.
const BASE_ENV = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  SESSION_SECRET: "a".repeat(32),
  API_KEY_ENCRYPTION_KEY: "b".repeat(32),
};

describe("loadConfig / LOCAL_AUTH_ENABLED (issue #125)", () => {
  it("defaults to true when unset", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.LOCAL_AUTH_ENABLED).toBe(true);
  });

  it('parses "true" as true', () => {
    const config = loadConfig({ ...BASE_ENV, LOCAL_AUTH_ENABLED: "true" });
    expect(config.LOCAL_AUTH_ENABLED).toBe(true);
  });

  it('parses "false" as false, not true', () => {
    const config = loadConfig({ ...BASE_ENV, LOCAL_AUTH_ENABLED: "false" });
    expect(config.LOCAL_AUTH_ENABLED).toBe(false);
  });

  it("rejects an unrecognized value instead of silently coercing it", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    loadConfig({ ...BASE_ENV, LOCAL_AUTH_ENABLED: "yes" });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "Invalid environment configuration:",
      expect.objectContaining({ LOCAL_AUTH_ENABLED: expect.any(Array) }),
    );

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("loadConfig / PYROSCOPE_ENABLED (issue #185)", () => {
  it("defaults to false when unset", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.PYROSCOPE_ENABLED).toBe(false);
  });

  it('parses "false" as false, not true (same coercion trap as issue #125)', () => {
    const config = loadConfig({ ...BASE_ENV, PYROSCOPE_ENABLED: "false" });
    expect(config.PYROSCOPE_ENABLED).toBe(false);
  });

  it('parses "true" as true', () => {
    const config = loadConfig({ ...BASE_ENV, PYROSCOPE_ENABLED: "true" });
    expect(config.PYROSCOPE_ENABLED).toBe(true);
  });
});
