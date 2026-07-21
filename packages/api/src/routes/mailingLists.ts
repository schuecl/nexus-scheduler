import { Router } from "express";
import { Prisma } from "@nexus-scheduler/shared/prisma";
import { createMailingListSchema, updateMailingListSchema } from "@nexus-scheduler/shared";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { recordAuditEvent, diffChangedFields } from "../audit.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

const LIST_SELECT = {
  id: true,
  name: true,
  emails: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} as const;

function isNotFoundError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";
}

function canManage(user: { id: string; role: string }, list: { createdById: string }): boolean {
  return user.role === "ADMIN" || list.createdById === user.id;
}

// A user's own saved mailing lists (issue #219) — a personal, reusable
// set of notification-recipient email addresses, attachable to any Job's
// notifications the user can edit (see jobs.ts's PUT /:id/notifications).
// Unlike WebhookDestination (an admin-maintained allow-list, §2.2/§10),
// ownership here is per-user — everyone manages their own lists, same
// shape as a personal ApiKey — so there is no admin-only gate on
// create/update/delete, only an ownership check.
export function createMailingListsRouter(): Router {
  const router = Router();

  // Only the caller's own lists, same posture as GET /api/api-keys:
  // a personal resource is never listed for anyone but its owner, admin
  // included — an admin's broader privileges apply to *managing* a list
  // they don't own (see canManage), not to browsing everyone's contacts.
  router.get("/", requireAuth, asyncHandler(async (req, res) => {
    const user = req.session.user!;
    const lists = await prisma.mailingList.findMany({
      where: { createdById: user.id },
      select: LIST_SELECT,
      orderBy: { name: "asc" },
    });
    res.json(lists);
  }));

  router.post("/", requireAuth, asyncHandler(async (req, res) => {
    const parsed = createMailingListSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;

    const list = await prisma.mailingList.create({
      data: { name: parsed.data.name, emails: parsed.data.emails, createdById: user.id },
      select: LIST_SELECT,
    });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "mailing_list.create",
      targetType: "mailing_list",
      targetId: list.id,
      targetName: list.name,
      category: "lifecycle",
      result: "SUCCESS",
    });

    res.status(201).json(list);
  }));

  router.patch("/:id", requireAuth, asyncHandler(async (req, res, next) => {
    const parsed = updateMailingListSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;
    const existing = await prisma.mailingList.findUnique({ where: { id: req.params.id }, select: LIST_SELECT });
    if (!existing) {
      res.status(404).json({ error: "mailing list not found" });
      return;
    }
    if (!canManage(user, existing)) {
      res.status(403).json({ error: "not permitted to edit this mailing list" });
      return;
    }

    let list;
    try {
      list = await prisma.mailingList.update({
        where: { id: req.params.id },
        data: parsed.data,
        select: LIST_SELECT,
      });
    } catch (err) {
      if (isNotFoundError(err)) {
        res.status(404).json({ error: "mailing list not found" });
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
      action: "mailing_list.update",
      targetType: "mailing_list",
      targetId: list.id,
      targetName: list.name,
      category: "lifecycle",
      changes: diffChangedFields(existing, list, Object.keys(parsed.data) as (keyof typeof existing)[]),
      result: "SUCCESS",
    });

    res.json(list);
  }));

  // Hard delete — job_mailing_lists cascades, so any Job that had this
  // list attached just stops notifying its addresses, same practical
  // effect as removing a WebhookDestination has on the Jobs it was
  // attached to.
  router.delete("/:id", requireAuth, asyncHandler(async (req, res, next) => {
    const user = req.session.user!;
    const existing = await prisma.mailingList.findUnique({ where: { id: req.params.id }, select: LIST_SELECT });
    if (!existing) {
      res.status(404).json({ error: "mailing list not found" });
      return;
    }
    if (!canManage(user, existing)) {
      res.status(403).json({ error: "not permitted to delete this mailing list" });
      return;
    }

    try {
      await prisma.mailingList.delete({ where: { id: req.params.id } });
    } catch (err) {
      if (isNotFoundError(err)) {
        res.status(404).json({ error: "mailing list not found" });
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
      action: "mailing_list.delete",
      targetType: "mailing_list",
      targetId: existing.id,
      targetName: existing.name,
      category: "lifecycle",
      result: "SUCCESS",
    });

    res.status(204).send();
  }));

  return router;
}
