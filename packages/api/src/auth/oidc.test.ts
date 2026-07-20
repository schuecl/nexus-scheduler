import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { initOidcClient } from "./oidc.js";

// Regression test for issue #198: OIDC_ISSUER_URL/CLIENT_ID/REDIRECT_URI
// are set unconditionally by docker-compose.yml's api service, while
// OIDC_CLIENT_SECRET is left for the operator to fill in after creating
// the Keycloak client by hand. Before this fix, a missing secret wasn't
// distinguished from "OIDC not configured at all": initOidcClient built
// a client with client_secret: undefined, and the token exchange failed
// silently after the user had already authenticated at Keycloak, with
// the app falling back to local login as if nothing were wrong.
const BASE_ENV = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  SESSION_SECRET: "a".repeat(32),
  API_KEY_ENCRYPTION_KEY: "b".repeat(32),
};

const OIDC_ENV = {
  ...BASE_ENV,
  OIDC_ISSUER_URL: "http://keycloak:8080/realms/nexus-scheduler",
  OIDC_CLIENT_ID: "nexus-scheduler",
  OIDC_REDIRECT_URI: "http://localhost:8080/auth/callback",
};

describe("initOidcClient / OIDC_CLIENT_SECRET (issue #198)", () => {
  it("warns 'not configured' and returns undefined when nothing is set", async () => {
    const config = loadConfig(BASE_ENV);
    const logger = createLogger(config);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);

    const client = await initOidcClient(config, logger);

    expect(client).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("OIDC not configured"));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("logs an error and returns undefined when the secret is missing but everything else is set", async () => {
    const config = loadConfig(OIDC_ENV);
    const logger = createLogger(config);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);

    const client = await initOidcClient(config, logger);

    expect(client).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ issuer: OIDC_ENV.OIDC_ISSUER_URL }),
      expect.stringContaining("OIDC_CLIENT_SECRET is missing"),
    );
  });
});
