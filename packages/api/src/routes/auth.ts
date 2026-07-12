import { Router } from "express";
import bcrypt from "bcryptjs";
import { localLoginSchema, forgotPasswordSchema, resetPasswordSchema, hashResetToken } from "@nexus-scheduler/shared";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { generatePkce, getOidcClient, mapKeycloakRole } from "../auth/oidc.js";
import { prisma } from "../db.js";
import { recordAuditEvent } from "../audit.js";
import { issuePasswordResetEmail } from "../passwordReset.js";

const BCRYPT_ROUNDS = 12;
// A precomputed hash of a value nobody will ever type, used to keep
// bcrypt.compare's ~100ms cost constant whether or not the email exists
// — otherwise a non-existent-account login would return measurably
// faster than a wrong-password one, an account-enumeration side channel.
const DUMMY_HASH = bcrypt.hashSync("nexus-scheduler-dummy-comparison-target", BCRYPT_ROUNDS);

export function createAuthRouter(config: AppConfig, logger: Logger): Router {
  const router = Router();

  router.get("/login", (req, res) => {
    let client;
    try {
      client = getOidcClient();
    } catch {
      // Covers both "not configured" and "configured but discovery
      // failed at startup" (e.g. the realm doesn't exist yet) — either
      // way SSO just isn't available right now, not a server error.
      res.status(503).json({ error: "OIDC is not configured or unavailable on this deployment" });
      return;
    }
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

  // Break-glass path (§4) — the built-in admin (BOOTSTRAP_ADMIN_EMAIL)
  // can always log in here regardless of LOCAL_AUTH_ENABLED, since the
  // whole point is not depending on Keycloak — or an admin's own config
  // toggle — being available. Ordinary local accounts are blocked when
  // the flag is off.
  router.post("/local-login", async (req, res) => {
    const parsed = localLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const isBootstrapAdmin = parsed.data.email === config.BOOTSTRAP_ADMIN_EMAIL;
    if (!config.LOCAL_AUTH_ENABLED && !isBootstrapAdmin) {
      res.status(503).json({ error: "local login is disabled on this deployment" });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    const hashToCompare = user?.authSource === "LOCAL" && user.passwordHash ? user.passwordHash : DUMMY_HASH;
    const passwordOk = await bcrypt.compare(parsed.data.password, hashToCompare);

    if (!user || user.authSource !== "LOCAL" || !user.active || !passwordOk) {
      await recordAuditEvent({
        req,
        actorType: "USER",
        actorId: user?.id ?? "unknown",
        actorEmail: parsed.data.email,
        action: "login.failure",
        targetType: "user",
        result: "FAILURE",
        errorMessage: "invalid credentials",
      });
      res.status(401).json({ error: "invalid email or password" });
      return;
    }

    req.session.user = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      authSource: "LOCAL",
    };

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

    res.json(req.session.user);
  });

  // Deliberately identical response whether or not the email exists —
  // standard practice against account enumeration via this endpoint.
  // Gated by LOCAL_AUTH_ENABLED: the built-in admin's password is always
  // controlled by BOOTSTRAP_ADMIN_PASSWORD, never self-reset, so there's
  // no legitimate use of this path when ordinary local accounts are off.
  router.post("/local/forgot-password", async (req, res) => {
    if (!config.LOCAL_AUTH_ENABLED) {
      res.status(503).json({ error: "local accounts are disabled on this deployment" });
      return;
    }
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    if (user && user.authSource === "LOCAL" && user.active) {
      await issuePasswordResetEmail(config, logger, user);
    }

    res.status(204).send();
  });

  router.post("/local/reset-password", async (req, res) => {
    if (!config.LOCAL_AUTH_ENABLED) {
      res.status(503).json({ error: "local accounts are disabled on this deployment" });
      return;
    }
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const tokenHash = hashResetToken(parsed.data.token);
    const user = await prisma.user.findFirst({
      where: { passwordResetTokenHash: tokenHash, passwordResetExpiresAt: { gt: new Date() } },
    });
    if (!user) {
      res.status(400).json({ error: "reset link is invalid or has expired" });
      return;
    }

    const passwordHash = await bcrypt.hash(parsed.data.newPassword, BCRYPT_ROUNDS);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, passwordResetTokenHash: null, passwordResetExpiresAt: null },
    });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "user.password_reset",
      targetType: "user",
      targetId: user.id,
      result: "SUCCESS",
    });

    res.status(204).send();
  });

  return router;
}
