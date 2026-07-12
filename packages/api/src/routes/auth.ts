import { Router } from "express";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { generatePkce, getOidcClient, mapKeycloakRole } from "../auth/oidc.js";
import { prisma } from "../db.js";
import { recordAuditEvent } from "../audit.js";

export function createAuthRouter(config: AppConfig, logger: Logger): Router {
  const router = Router();

  router.get("/login", (req, res) => {
    if (!config.OIDC_CLIENT_ID) {
      res.status(503).json({ error: "OIDC is not configured on this deployment" });
      return;
    }
    const client = getOidcClient();
    const { codeVerifier, codeChallenge, state, nonce } = generatePkce();
    req.session.oidc = {
      state,
      nonce,
      codeVerifier,
      returnTo: typeof req.query.returnTo === "string" ? req.query.returnTo : undefined,
    };
    const authUrl = client.authorizationUrl({
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    res.redirect(authUrl);
  });

  router.get("/callback", async (req, res) => {
    const pending = req.session.oidc;
    if (!pending) {
      res.status(400).json({ error: "no pending OIDC login in this session" });
      return;
    }

    try {
      const client = getOidcClient();
      const params = client.callbackParams(req);
      const tokenSet = await client.callback(config.OIDC_REDIRECT_URI, params, {
        state: pending.state,
        nonce: pending.nonce,
        code_verifier: pending.codeVerifier,
      });
      const claims = tokenSet.claims();
      const email = claims.email;
      if (!email) {
        res.status(400).json({ error: "OIDC token did not include an email claim" });
        return;
      }

      const role = mapKeycloakRole(
        claims as unknown as Record<string, unknown>,
        config.OIDC_CLIENT_ID!,
      );

      const user = await prisma.user.upsert({
        where: { email },
        create: {
          email,
          givenName: claims.given_name ?? null,
          familyName: claims.family_name ?? null,
          displayName: claims.name ?? null,
          authSource: "OIDC",
          role,
        },
        update: {
          givenName: claims.given_name ?? null,
          familyName: claims.family_name ?? null,
          displayName: claims.name ?? null,
          role,
        },
      });

      req.session.user = {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        authSource: "OIDC",
      };
      delete req.session.oidc;

      await recordAuditEvent({
        req,
        actorType: "USER",
        actorId: user.id,
        actorEmail: user.email,
        action: "login.success",
        targetType: "user",
        targetId: user.id,
        result: "SUCCESS",
      });

      res.redirect(pending.returnTo ?? "/");
    } catch (err) {
      logger.error({ err }, "OIDC callback failed");
      await recordAuditEvent({
        req,
        actorType: "USER",
        actorId: "unknown",
        actorEmail: "unknown",
        action: "login.failure",
        targetType: "user",
        result: "FAILURE",
        errorMessage: err instanceof Error ? err.message : "unknown error",
      });
      res.status(401).json({ error: "authentication failed" });
    }
  });

  router.post("/logout", async (req, res) => {
    const user = req.session.user;
    req.session.destroy((err) => {
      if (err) {
        logger.error({ err }, "session destroy failed during logout");
      }
    });
    if (user) {
      await recordAuditEvent({
        actorType: "USER",
        actorId: user.id,
        actorEmail: user.email,
        action: "logout.success",
        targetType: "user",
        targetId: user.id,
        result: "SUCCESS",
      });
    }
    res.status(204).send();
  });

  router.get("/me", (req, res) => {
    if (!req.session.user) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }
    res.json(req.session.user);
  });

  return router;
}
