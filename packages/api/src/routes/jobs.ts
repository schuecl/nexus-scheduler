import { Router } from "express";
import { createJobSchema } from "@nexus-scheduler/shared";
import { prisma } from "../db.js";
import { requireAuth, requireEditor } from "../middleware/requireAuth.js";
import { recordAuditEvent } from "../audit.js";

// Minimal CRUD slice to prove the Express + Prisma + shared-zod-schema +
// audit-logging pattern end to end. Authorization here is intentionally
// coarse (role-only) — Project-ACL-aware access checks (§2.3) land when
// Projects/Teams themselves are implemented.
export function createJobsRouter(): Router {
  const router = Router();

  router.get("/", requireAuth, async (req, res) => {
    const jobs = await prisma.job.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json(jobs);
  });

  router.get("/:id", requireAuth, async (req, res) => {
    const job = await prisma.job.findUnique({ where: { id: req.params.id } });
    if (!job) {
      res.status(404).json({ error: "job not found" });
      return;
    }
    res.json(job);
  });

  router.post("/", requireAuth, requireEditor, async (req, res) => {
    const parsed = createJobSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;

    const job = await prisma.job.create({
      data: {
        ...parsed.data,
        createdById: user.id,
      },
    });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "job.create",
      targetType: "job",
      targetId: job.id,
      targetName: job.name,
      result: "SUCCESS",
    });

    res.status(201).json(job);
  });

  return router;
}
