import { Issuer, generators, type Client } from "openid-client";
import type { AppConfig } from "../config.js";
import type { RoleName } from "@nexus-scheduler/shared";
import { ROLES } from "@nexus-scheduler/shared";
import type { Logger } from "../logger.js";

let client: Client | undefined;

// Discovers the Keycloak realm's OIDC configuration. CAC/PIV smart-card
// auth happens entirely upstream inside Keycloak (REQUIREMENTS.md §4)
// — Nexus Scheduler never sees a certificate, only the resulting OIDC
// token.
//
// Deliberately never throws: an unreachable issuer or a realm that
// hasn't been created yet (the default state of the local Compose
// stack's Keycloak — see README) must not take the whole API process
// down. Local/break-glass admin login (§4) is explicitly supposed to
// work "regardless of... Keycloak... being available," which isn't
// true if a failed discovery here crashes startup before the HTTP
// server ever starts listening.
export async function initOidcClient(config: AppConfig, logger: Logger): Promise<Client | undefined> {
  const { OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI } = config;

  if (!OIDC_ISSUER_URL || !OIDC_CLIENT_ID || !OIDC_REDIRECT_URI) {
    logger.warn("OIDC not configured — only local-account login (if enabled) will work");
    return undefined;
  }

  // Issuer/client ID/redirect URI are set but the secret isn't — this
  // is not "unconfigured," it's misconfigured. Compose's api service
  // sets the first three unconditionally, so this is the actual
  // default state until an operator finishes creating the Keycloak
  // client (issue #198): without this check the token exchange is
  // attempted anyway, with an undefined client_secret, and fails only
  // after the user has already authenticated at Keycloak — while the
  // app silently falls back to local BOOTSTRAP_ADMIN_EMAIL login as if
  // nothing were wrong.
  if (!OIDC_CLIENT_SECRET) {
    logger.error(
      { issuer: OIDC_ISSUER_URL },
      "OIDC_ISSUER_URL is set but OIDC_CLIENT_SECRET is missing — SSO is configured but the token exchange will fail after the user authenticates at Keycloak. Set OIDC_CLIENT_SECRET to the confidential client's secret, or unset OIDC_ISSUER_URL to run local-only.",
    );
    return undefined;
  }

  try {
    const issuer = await Issuer.discover(OIDC_ISSUER_URL);
    client = new issuer.Client({
      client_id: OIDC_CLIENT_ID,
      client_secret: OIDC_CLIENT_SECRET,
      redirect_uris: [OIDC_REDIRECT_URI],
      response_types: ["code"],
    });
    return client;
  } catch (err) {
    logger.error(
      { err, issuer: OIDC_ISSUER_URL },
      "OIDC discovery failed — SSO login is unavailable until this is fixed; local-account login (if enabled) still works",
    );
    return undefined;
  }
}

// Used by request handlers instead of a bare initOidcClient() call: if
// discovery already succeeded (at startup or a prior request), reuse
// the cached client; otherwise retry it right now. This is what lets
// SSO start working the moment an operator finishes creating the
// Keycloak realm/client, without needing to restart the API — the
// one-shot call in index.ts's startup path would otherwise leave SSO
// permanently unavailable for the life of the process if Keycloak
// wasn't ready (or the realm didn't exist yet) at that exact moment.
export async function getOrInitOidcClient(config: AppConfig, logger: Logger): Promise<Client | undefined> {
  if (client) {
    return client;
  }
  return initOidcClient(config, logger);
}

export function getOidcClient(): Client {
  if (!client) {
    throw new Error("OIDC is not configured or failed to initialize on this deployment");
  }
  return client;
}

export function generatePkce() {
  const codeVerifier = generators.codeVerifier();
  const codeChallenge = generators.codeChallenge(codeVerifier);
  const state = generators.state();
  const nonce = generators.nonce();
  return { codeVerifier, codeChallenge, state, nonce };
}

/**
 * Maps Keycloak client roles (resource_access.<client_id>.roles) onto
 * Nexus Scheduler's role model, per REQUIREMENTS.md §4. Falls back to
 * VIEW when the user has no recognized client role, rather than
 * defaulting to a more privileged role.
 */
export function mapKeycloakRole(claims: Record<string, unknown>, clientId: string): RoleName {
  const resourceAccess = claims["resource_access"] as
    | Record<string, { roles?: string[] }>
    | undefined;
  const clientRoles = resourceAccess?.[clientId]?.roles ?? [];

  for (const role of ROLES) {
    if (clientRoles.some((r) => r.toUpperCase() === role)) {
      return role;
    }
  }
  return "VIEW";
}
