import { Router } from "express";
import { Prisma } from "@nexus-scheduler/shared/prisma";
import {
  createWebhookDestinationSchema,
  updateWebhookDestinationSchema,
  generateWebhookSecret,
  encryptSecret,
} from "@nexus-scheduler/shared";
import { prisma } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/requireAuth.js";
import { recordAuditEvent } from "../audit.js";
import type { AppConfig } from "../config.js";

function isNotFoundError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";
}

// The admin-maintained allow-list itself (REQUIREMENTS §2.2/§10) — a Job
// can only ever attach one of *these* rows, never an arbitrary URL, which
// is what keeps outbound delivery from becoming an SSRF/exfiltration path.
export function createWebhookDestinationsRouter(config: AppConfig): Router {
  const router = Router();

  // Any authenticated user can see *which destinations exist* (to pick
  // from when wiring up a Job's notifications) — but only active ones,
  // since a disabled destination shouldn't be attachable to a Job. An
  // admin managing the allow-list itself needs to see disabled rows too
  // (otherwise there'd be no way to re-enable or delete one — it would
  // just vanish from the one screen that manages it).
  router.get("/", requireAuth, async (req, res) => {
    const isAdmin = req.session.user!.role === "ADMIN";
    const destinations = await prisma.webhookDestination.findMany({
      where: isAdmin ? undefined : { active: true },
      select: { id: true, name: true, url: true, active: true, createdAt: true },
      orderBy: { name: "asc" },
    });
    res.json(destinations);
  });

  router.post("/", requireAuth, requireAdmin, async (req, res) => {
    const parsed = createWebhookDestinationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;

    const encryptedHmacSecret = encryptSecret(generateWebhookSecret(), config.API_KEY_ENCRYPTION_KEY);
    const destination = await prisma.webhookDestination.create({
      data: { name: parsed.data.name, url: parsed.data.url, encryptedHmacSecret },
      select: { id: true, name: true, url: true, active: true, createdAt: true },
    });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "webhook_destination.create",
      targetType: "webhook",
      targetId: destination.id,
      targetName: destination.name,
      result: "SUCCESS",
    });

    res.status(201).json(destination);
  });

  router.patch("/:id", requireAuth, requireAdmin, async (req, res, next) => {
    const parsed = updateWebhookDestinationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;
    let destination;
    try {
      destination = await prisma.webhookDestination.update({
        where: { id: req.params.id },
        data: parsed.data,
        select: { id: true, name: true, url: true, active: true, createdAt: true },
      });
    } catch (err) {
      if (isNotFoundError(err)) {
        res.status(404).json({ error: "webhook destination not found" });
        return;
      }
      next(err);
      return;
    }

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "webhook_destination.update",
      targetType: "webhook",
      targetId: destination.id,
      targetName: destination.name,
      result: "SUCCESS",
      details: parsed.data,
    });

    res.json(destination);
  });

  // Hard delete — job_webhook_destinations cascades, so any Job that had
  // this destination attached just stops notifying it, same practical
  // effect as removing it from the allow-list would have anyway.
  router.delete("/:id", requireAuth, requireAdmin, async (req, res, next) => {
    const user = req.session.user!;
    let destination;
    try {
      destination = await prisma.webhookDestination.delete({ where: { id: req.params.id } });
    } catch (err) {
      if (isNotFoundError(err)) {
        res.status(404).json({ error: "webhook destination not found" });
        return;
      }
      next(err);
      return;
    }

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "webhook_destination.delete",
      targetType: "webhook",
      targetId: destination.id,
      targetName: destination.name,
      result: "SUCCESS",
    });

    res.status(204).send();
  });

  return router;
}
