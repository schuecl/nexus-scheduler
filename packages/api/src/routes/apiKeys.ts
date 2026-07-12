import { Router } from "express";
import { createApiKeySchema, encryptSecret } from "@nexus-scheduler/shared";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { getEffectiveTeamIds } from "../access.js";
import { recordAuditEvent } from "../audit.js";
import type { AppConfig } from "../config.js";

// LibreChat API keys — entered per-user via the web UI, or held by a
// Team for shared/durable schedules (REQUIREMENTS.md §2/§2.1/§4). Raw
// key material is encrypted at rest and never echoed back in a response
// after creation.
export function createApiKeysRouter(config: AppConfig): Router {
  const router = Router();

  // Every key the current user is allowed to *use* when building a Job:
  // their own personal keys, plus any Team-owned key for a Team they're
  // effectively a member of.
  router.get("/", requireAuth, async (req, res) => {
    const user = req.session.user!;
    const effectiveTeamIds = await getEffectiveTeamIds(user.id);

    const keys = await prisma.apiKey.findMany({
      where: {
        OR: [
          { ownerType: "USER", ownerUserId: user.id },
          ...(effectiveTeamIds.length > 0
            ? [{ ownerType: "TEAM" as const, ownerTeamId: { in: effectiveTeamIds } }]
            : []),
        ],
      },
      select: {
        id: true,
        label: true,
        ownerType: true,
        ownerTeamId: true,
        owningTeam: { select: { name: true } },
        status: true,
        expiresAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(keys);
  });

  router.post("/", requireAuth, async (req, res) => {
    const parsed = createApiKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;

    if (parsed.data.ownerType === "TEAM") {
      const effectiveTeamIds = await getEffectiveTeamIds(user.id);
      if (!effectiveTeamIds.includes(parsed.data.ownerTeamId!)) {
        res.status(403).json({ error: "not a member of that Team" });
        return;
      }
    }

    const encryptedKey = encryptSecret(parsed.data.key, config.API_KEY_ENCRYPTION_KEY);
    const apiKey = await prisma.apiKey.create({
      data: {
        ownerType: parsed.data.ownerType,
        ownerUserId: parsed.data.ownerType === "USER" ? user.id : undefined,
        ownerTeamId: parsed.data.ownerType === "TEAM" ? parsed.data.ownerTeamId : undefined,
        label: parsed.data.label,
        encryptedKey,
        expiresAt: parsed.data.expiresAt,
      },
      select: { id: true, label: true, ownerType: true, ownerTeamId: true, status: true, expiresAt: true },
    });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "apikey.create",
      targetType: "apikey",
      targetId: apiKey.id,
      targetName: apiKey.label ?? undefined,
      result: "SUCCESS",
      details: { ownerType: apiKey.ownerType },
    });

    res.status(201).json(apiKey);
  });

  router.delete("/:id", requireAuth, async (req, res) => {
    const user = req.session.user!;
    const key = await prisma.apiKey.findUnique({ where: { id: req.params.id } });
    if (!key) {
      res.status(404).json({ error: "key not found" });
      return;
    }

    const allowed =
      user.role === "ADMIN" ||
      (key.ownerType === "USER" && key.ownerUserId === user.id) ||
      (key.ownerType === "TEAM" &&
        key.ownerTeamId !== null &&
        (await getEffectiveTeamIds(user.id)).includes(key.ownerTeamId));
    if (!allowed) {
      res.status(403).json({ error: "not permitted to revoke this key" });
      return;
    }

    await prisma.apiKey.update({ where: { id: req.params.id }, data: { status: "REVOKED" } });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "apikey.revoke",
      targetType: "apikey",
      targetId: key.id,
      targetName: key.label ?? undefined,
      result: "SUCCESS",
    });

    res.status(204).send();
  });

  return router;
}
