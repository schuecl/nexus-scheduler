import { Issuer, generators, type Client } from "openid-client";
import type { AppConfig } from "../config.js";
import type { RoleName } from "@nexus-scheduler/shared";
import { ROLES } from "@nexus-scheduler/shared";
import type { Logger } from "../logger.js";

let client: Client | undefined;

// Discovers the Keycloak realm's OIDC configuration once at startup.
// CAC/PIV smart-card auth happens entirely upstream inside Keycloak
// (REQUIREMENTS.md §4) — Nexus Scheduler never sees a certificate, only
// the resulting OIDC token.
//
// Deliberately never throws: an unreachable issuer or a realm that
// hasn't been created yet (the default state of the local Compose
// stack's Keycloak — see README) must not take the whole API process
// down. Local/break-glass admin login (§4) is explicitly supposed to
// work "regardless of... Keycloak... being available," which isn't
// true if a failed discovery here crashes startup before the HTTP
// server ever starts listening.
export async function initOidcClient(config: AppConfig, logger: Logger): Promise<Client | undefined> {
  if (!config.OIDC_ISSUER_URL || !config.OIDC_CLIENT_ID || !config.OIDC_REDIRECT_URI) {
    logger.warn("OIDC not configured — only local-account login (if enabled) will work");
    return undefined;
  }

  try {
    const issuer = await Issuer.discover(config.OIDC_ISSUER_URL);
    client = new issuer.Client({
      client_id: config.OIDC_CLIENT_ID,
      client_secret: config.OIDC_CLIENT_SECRET,
      redirect_uris: [config.OIDC_REDIRECT_URI],
      response_types: ["code"],
    });
    return client;
  } catch (err) {
    logger.error(
      { err, issuer: config.OIDC_ISSUER_URL },
      "OIDC discovery failed — SSO login is unavailable until this is fixed; local-account login (if enabled) still works",
    );
    return undefined;
  }
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
