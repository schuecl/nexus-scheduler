import { Router } from "express";
import { updateAppSettingsSchema } from "@nexus-scheduler/shared";
import { prisma } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/requireAuth.js";
import { recordAuditEvent } from "../audit.js";

const SETTINGS_ID = 1; // singleton row, enforced here rather than a real sequence

// Branding (§5) and the system-wide classification banner (§6). GET is
// deliberately unauthenticated — the banner has to render on every page
// regardless of login state, so the frontend needs to fetch it before
// (or independent of) auth resolving.
export function createSettingsRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const settings = await prisma.appSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID },
      update: {},
    });
    res.json(settings);
  });

  router.patch("/", requireAuth, requireAdmin, async (req, res) => {
    const parsed = updateAppSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;

    const settings = await prisma.appSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, ...parsed.data },
      update: parsed.data,
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
      details: parsed.data,
    });

    res.json(settings);
  });

  return router;
}
