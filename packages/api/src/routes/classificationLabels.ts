import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@nexus-scheduler/shared/prisma";
import { cssColorSchema } from "@nexus-scheduler/shared";
import { prisma } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/requireAuth.js";
import { recordAuditEvent } from "../audit.js";

function isNotFoundError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";
}

// "Clear the existing default, then set the new one" needs true
// serializability, not just row locking: verified under real concurrent
// load that with READ COMMITTED (Postgres's default) and no existing
// default row yet, two concurrent requests can both see "0 rows to
// clear" and both insert their own — an UPDATE's row lock can't prevent
// a race against a row that doesn't exist yet. SERIALIZABLE isolation
// detects that write-skew and aborts one side with P2034 at commit
// time (also verified directly); retrying it is the documented,
// expected response to that error, not a symptom of something wrong.
// Higher than a typical retry budget (3) on purpose — verified directly
// that a burst of 20 truly concurrent isDefault:true requests can
// exhaust several attempts before enough of them stop colliding with
// each other; with jitter between attempts this converges quickly in
// practice, and this is a rare admin action, not a hot path.
const MAX_SERIALIZATION_RETRIES = 8;

function isSerializationConflict(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034";
}

function jitterDelay(attempt: number): Promise<void> {
  const ms = Math.floor(Math.random() * 25 * attempt);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withSerializableRetry<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (err) {
      if (!isSerializationConflict(err) || attempt >= MAX_SERIALIZATION_RETRIES) {
        throw err;
      }
      await jitterDelay(attempt);
    }
  }
}

const createLabelSchema = z.object({
  text: z.string().min(1).max(100),
  abbreviation: z.string().max(20).optional(),
  badgeBgColor: cssColorSchema,
  badgeTextColor: cssColorSchema,
  sortOrder: z.number().int().default(0),
  isDefault: z.boolean().default(false),
});

// Rename/recolor/reorder an existing label (REQUIREMENTS §6: "create,
// rename, reorder, or retire labels over time") — same shape as create,
// all optional since a PATCH may touch just one field.
const updateLabelSchema = createLabelSchema.partial();

// Object-level classification labels (REQUIREMENTS.md §6) — an
// admin-editable taxonomy, deliberately independent of the system-wide
// classification banner, which isn't app-managed data at all.
export function createClassificationLabelsRouter(): Router {
  const router = Router();

  router.get("/", requireAuth, async (_req, res) => {
    const labels = await prisma.classificationLabel.findMany({ orderBy: { sortOrder: "asc" } });
    res.json(labels);
  });

  router.post("/", requireAuth, requireAdmin, async (req, res, next) => {
    const parsed = createLabelSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;

    let label;
    try {
      label = parsed.data.isDefault
        ? await withSerializableRetry((tx) =>
            tx.classificationLabel
              .updateMany({ data: { isDefault: false }, where: { isDefault: true } })
              .then(() => tx.classificationLabel.create({ data: parsed.data })),
          )
        : await prisma.classificationLabel.create({ data: parsed.data });
    } catch (err) {
      if (isSerializationConflict(err)) {
        res.status(409).json({ error: "too much concurrent activity setting the default label — please retry" });
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
      action: "classification_label.create",
      targetType: "classification_label",
      targetId: label.id,
      targetName: label.text,
      result: "SUCCESS",
    });

    res.status(201).json(label);
  });

  router.patch("/:id", requireAuth, requireAdmin, async (req, res, next) => {
    const parsed = updateLabelSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;

    let label;
    try {
      // Same rationale as create above.
      label = parsed.data.isDefault
        ? await withSerializableRetry((tx) =>
            tx.classificationLabel
              .updateMany({ data: { isDefault: false }, where: { isDefault: true } })
              .then(() => tx.classificationLabel.update({ where: { id: req.params.id }, data: parsed.data })),
          )
        : await prisma.classificationLabel.update({ where: { id: req.params.id }, data: parsed.data });
    } catch (err) {
      if (isNotFoundError(err)) {
        res.status(404).json({ error: "classification label not found" });
        return;
      }
      if (isSerializationConflict(err)) {
        res.status(409).json({ error: "too much concurrent activity setting the default label — please retry" });
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
      action: "classification_label.update",
      targetType: "classification_label",
      targetId: label.id,
      targetName: label.text,
      result: "SUCCESS",
      details: parsed.data,
    });

    res.json(label);
  });

  // Hard delete, but only when nothing currently carries this label —
  // silently reassigning a Project's classification marking to nothing
  // is exactly the kind of thing REQUIREMENTS §6 is careful to avoid.
  // Retiring a label that's still in use means editing it (e.g. its
  // text/color) or reassigning the Projects that use it first.
  router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
    const user = req.session.user!;
    const label = await prisma.classificationLabel.findUnique({ where: { id: req.params.id } });
    if (!label) {
      res.status(404).json({ error: "classification label not found" });
      return;
    }

    const inUseCount = await prisma.project.count({ where: { classificationLabelId: label.id } });
    if (inUseCount > 0) {
      res.status(409).json({
        error: `cannot delete — ${inUseCount} Project(s) are currently tagged with this label. Reassign them first, or edit this label instead of deleting it.`,
      });
      return;
    }

    await prisma.classificationLabel.delete({ where: { id: label.id } });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "classification_label.delete",
      targetType: "classification_label",
      targetId: label.id,
      targetName: label.text,
      result: "SUCCESS",
    });

    res.status(204).send();
  });

  return router;
}
