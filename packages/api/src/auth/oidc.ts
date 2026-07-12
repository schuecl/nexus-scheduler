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
export async function initOidcClient(config: AppConfig, logger: Logger): Promise<Client | undefined> {
  if (!config.OIDC_ISSUER_URL || !config.OIDC_CLIENT_ID || !config.OIDC_REDIRECT_URI) {
    logger.warn("OIDC not configured — only local-account login (if enabled) will work");
    return undefined;
  }

  const issuer = await Issuer.discover(config.OIDC_ISSUER_URL);
  client = new issuer.Client({
    client_id: config.OIDC_CLIENT_ID,
    client_secret: config.OIDC_CLIENT_SECRET,
    redirect_uris: [config.OIDC_REDIRECT_URI],
    response_types: ["code"],
  });
  return client;
}

export function getOidcClient(): Client {
  if (!client) {
    throw new Error("OIDC client requested before initOidcClient() completed");
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
