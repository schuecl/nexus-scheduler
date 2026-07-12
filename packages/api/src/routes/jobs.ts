import { Router } from "express";
import { createJobSchema, updateJobSchema, setJobWebhooksSchema, setJobNotificationsSchema } from "@nexus-scheduler/shared";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireProjectAccess } from "../middleware/requireProjectAccess.js";
import { requireJobAccess } from "../middleware/requireJobAccess.js";
import { recordAuditEvent } from "../audit.js";

// Mounted at /api/projects/:projectId/jobs (mergeParams) — same access
// convention as Prompts: EDIT to create, READ to list (REQUIREMENTS §2.3).
export function createProjectJobsRouter(): Router {
  const router = Router({ mergeParams: true });

  router.get("/", requireAuth, requireProjectAccess("READ"), async (req, res) => {
    const jobs = await prisma.job.findMany({
      where: { projectId: req.params.projectId },
      orderBy: { createdAt: "desc" },
    });
    res.json(jobs);
  });

  router.post("/", requireAuth, requireProjectAccess("EDIT"), async (req, res) => {
    const parsed = createJobSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;
    const projectId = req.params.projectId!;

    // Guard against cross-Project references: a Job's prompt must live
    // in the same Project, so access to one implies access to the other.
    const prompt = await prisma.prompt.findUnique({ where: { id: parsed.data.promptId } });
    if (!prompt || prompt.projectId !== projectId) {
      res.status(400).json({ error: "promptId must reference a prompt in this Project" });
      return;
    }

    const job = await prisma.job.create({
      data: { ...parsed.data, projectId, createdById: user.id },
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

// Mounted at /api/jobs — job-id-scoped operations. Access is entirely
// inherited from the Job's Project (requireJobAccess), same as Prompts.
export function createJobsRouter(): Router {
  const router = Router();

  router.get("/:id", requireAuth, requireJobAccess("READ"), async (req, res) => {
    const job = await prisma.job.findUnique({ where: { id: req.params.id } });
    res.json(job);
  });

  router.patch("/:id", requireAuth, requireJobAccess("EDIT"), async (req, res) => {
    const parsed = updateJobSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;

    if (parsed.data.promptId) {
      const prompt = await prisma.prompt.findUnique({ where: { id: parsed.data.promptId } });
      if (!prompt || prompt.projectId !== req.jobProjectId) {
        res.status(400).json({ error: "promptId must reference a prompt in this Project" });
        return;
      }
    }

    const job = await prisma.job.update({ where: { id: req.params.id }, data: parsed.data });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "job.update",
      targetType: "job",
      targetId: job.id,
      targetName: job.name,
      result: "SUCCESS",
      details: parsed.data,
    });

    res.json(job);
  });

  router.delete("/:id", requireAuth, requireJobAccess("EDIT"), async (req, res) => {
    const user = req.session.user!;
    const job = await prisma.job.delete({ where: { id: req.params.id } });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "job.delete",
      targetType: "job",
      targetId: job.id,
      targetName: job.name,
      result: "SUCCESS",
    });

    res.status(204).send();
  });

  // Which admin-allow-listed destinations (§2.2) get this Job's run
  // results — replaces the full set in one call rather than incremental
  // add/remove, which is simpler for what's normally a short list.
  router.get("/:id/webhooks", requireAuth, requireJobAccess("READ"), async (req, res) => {
    const links = await prisma.jobWebhookDestination.findMany({
      where: { jobId: req.params.id },
      include: { webhookDestination: { select: { id: true, name: true, url: true, active: true } } },
    });
    res.json(links.map((l) => l.webhookDestination));
  });

  router.put("/:id/webhooks", requireAuth, requireJobAccess("EDIT"), async (req, res) => {
    const parsed = setJobWebhooksSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;
    const jobId = req.params.id!;

    if (parsed.data.webhookDestinationIds.length > 0) {
      const count = await prisma.webhookDestination.count({
        where: { id: { in: parsed.data.webhookDestinationIds }, active: true },
      });
      if (count !== parsed.data.webhookDestinationIds.length) {
        res.status(400).json({ error: "one or more webhookDestinationIds are not a valid, active destination" });
        return;
      }
    }

    await prisma.$transaction([
      prisma.jobWebhookDestination.deleteMany({ where: { jobId } }),
      prisma.jobWebhookDestination.createMany({
        data: parsed.data.webhookDestinationIds.map((webhookDestinationId) => ({ jobId, webhookDestinationId })),
      }),
    ]);

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "job.webhooks.update",
      targetType: "job",
      targetId: jobId,
      result: "SUCCESS",
      details: { webhookDestinationIds: parsed.data.webhookDestinationIds },
    });

    res.status(204).send();
  });

  // Per-job email notification preferences (§2.2) — sent to the Job
  // owner (createdBy) on completion/failure, independent of the
  // admin-allow-listed webhook delivery above.
  router.put("/:id/notifications", requireAuth, requireJobAccess("EDIT"), async (req, res) => {
    const parsed = setJobNotificationsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;

    const job = await prisma.job.update({ where: { id: req.params.id }, data: parsed.data });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "job.notifications.update",
      targetType: "job",
      targetId: job.id,
      targetName: job.name,
      result: "SUCCESS",
      details: parsed.data,
    });

    res.json(job);
  });

  return router;
}
