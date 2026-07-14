import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { updateAppSettingsSchema, encryptSecret, buildRfc5424Message, sendSyslogMessage } from "@nexus-scheduler/shared";
import { prisma } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/requireAuth.js";
import { recordAuditEvent } from "../audit.js";
import { sendEmail, SmtpNotConfiguredError } from "../email.js";
import type { AppConfig } from "../config.js";

const SETTINGS_ID = 1; // singleton row, enforced here rather than a real sequence

// POST /syslog/test's optional body — the same syslog* fields as
// updateAppSettingsSchema, unprefixed, all optional so an admin can test
// their current (unsaved) form edits instead of only ever testing
// whatever was last saved.
const testSyslogOverridesSchema = z.object({
  host: z.string().min(1).optional(),
  port: z.number().int().positive().max(65535).optional(),
  transport: z.enum(["TCP", "UDP"]).optional(),
  tls: z.boolean().optional(),
  caCert: z.string().nullable().optional(),
});

const PUBLIC_FIELDS = {
  productName: true,
  logoUrl: true,
  primaryColor: true,
  classificationBannerText: true,
  classificationBannerBgColor: true,
  classificationBannerTextColor: true,
  // Login-screen consent banner (§40) — like the classification banner
  // above, must be readable before authentication resolves.
  consentBannerEnabled: true,
  consentBannerTitle: true,
  consentBannerBody: true,
  consentBannerRequireAcceptReject: true,
} as const;

// Shared with the PDF report route (§2.5) — reports carry the same
// branding/banner as the web UI's GET /api/settings, so both read
// through this one query rather than risking the two drifting apart.
export async function getPublicAppSettings() {
  return prisma.appSettings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID },
    update: {},
    select: PUBLIC_FIELDS,
  });
}

export function createSettingsRouter(config: AppConfig): Router {
  const router = Router();

  async function getOrCreateSettings() {
    return prisma.appSettings.upsert({ where: { id: SETTINGS_ID }, create: { id: SETTINGS_ID }, update: {} });
  }

  // Branding (§5) and the system-wide classification banner (§6) —
  // deliberately unauthenticated, since the banner has to render before/
  // independent of login resolving. Never includes SMTP config: that's
  // internal infrastructure detail (host, username, and — even
  // encrypted — password ciphertext) with no business being public.
  router.get("/", async (_req, res) => {
    res.json(await getPublicAppSettings());
  });

  // Full settings for the admin panel, including SMTP — password
  // presence only (`smtpPasswordSet`), never the ciphertext itself.
  router.get("/admin", requireAuth, requireAdmin, async (_req, res) => {
    const settings = await getOrCreateSettings();
    const { smtpEncryptedPassword, ...rest } = settings;
    res.json({ ...rest, smtpPasswordSet: !!smtpEncryptedPassword });
  });

  router.patch("/", requireAuth, requireAdmin, async (req, res) => {
    const parsed = updateAppSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;
    const { smtpPassword, ...rest } = parsed.data;

    const data = {
      ...rest,
      ...(smtpPassword !== undefined
        ? {
            smtpEncryptedPassword:
              smtpPassword === "" ? null : encryptSecret(smtpPassword, config.API_KEY_ENCRYPTION_KEY),
          }
        : {}),
    };

    const settings = await prisma.appSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, ...data },
      update: data,
    });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "system_settings.update",
      targetType: "system_setting",
      targetId: String(SETTINGS_ID),
      result: "SUCCESS",
      // Never audit the raw password — record only that it changed.
      details: { ...rest, smtpPasswordChanged: smtpPassword !== undefined },
    });

    const { smtpEncryptedPassword, ...publicSettings } = settings;
    res.json({ ...publicSettings, smtpPasswordSet: !!smtpEncryptedPassword });
  });

  router.post("/smtp/test", requireAuth, requireAdmin, async (req, res) => {
    const user = req.session.user!;
    try {
      await sendEmail(config, user.email, "Nexus Scheduler test email", "SMTP is configured correctly.");
      res.status(204).send();
    } catch (err) {
      if (err instanceof SmtpNotConfiguredError) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : "failed to send test email" });
    }
  });

  router.post("/syslog/test", requireAuth, requireAdmin, async (req, res) => {
    // Accepts the same fields as updateAppSettingsSchema's syslog* ones,
    // all optional — lets the admin test their in-progress form edits
    // (host/port/transport/tls/caCert) before hitting Save, rather than
    // only ever testing whatever was last saved. Any field omitted here
    // falls back to the saved value below.
    const parsed = testSyslogOverridesSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const overrides = parsed.data;

    const settings = await getOrCreateSettings();
    const effective = {
      host: overrides.host ?? settings.syslogHost,
      port: overrides.port ?? settings.syslogPort,
      transport: overrides.transport ?? settings.syslogTransport,
      tls: overrides.tls ?? settings.syslogTls,
      caCert: overrides.caCert !== undefined ? overrides.caCert : settings.syslogTlsCaCert,
    };
    if (!effective.host || !effective.port) {
      res.status(400).json({ error: "syslog is not configured — set host and port first" });
      return;
    }

    try {
      const message = buildRfc5424Message({
        eventId: randomUUID(),
        timestamp: new Date(),
        actorType: "USER",
        actorId: req.session.user!.id,
        actorEmail: req.session.user!.email,
        action: "system_settings.syslog_test",
        targetType: "system_setting",
        targetId: String(SETTINGS_ID),
        result: "SUCCESS",
        errorMessage: null,
        correlationId: null,
        details: { note: "manually triggered test message" },
        appName: "nexus-scheduler-api",
      });
      await sendSyslogMessage(
        {
          host: effective.host,
          port: effective.port,
          transport: effective.transport,
          tls: effective.tls,
          caCert: effective.caCert,
        },
        message,
      );
      res.status(204).send();
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "failed to send test syslog message" });
    }
  });

  return router;
}
