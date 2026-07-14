import { Router } from "express";
import type { Queue } from "bullmq";
import { type RunJobData, requestRunReportPdf } from "@nexus-scheduler/shared";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireJobAccess } from "../middleware/requireJobAccess.js";
import { requireRunAccess } from "../middleware/requireRunAccess.js";
import { recordAuditEvent } from "../audit.js";
import { getPublicAppSettings } from "./settings.js";
import type { AppConfig } from "../config.js";

// Mounted at /api/jobs/:jobId/runs (mergeParams) — same access convention
// as Schedules: READ to view history, EDIT to trigger a manual run
// (REQUIREMENTS §2.1/§2.3).
export function createJobRunsRouter(queue: Queue<RunJobData>): Router {
  const router = Router({ mergeParams: true });

  router.get("/", requireAuth, requireJobAccess("READ"), async (req, res) => {
    const runs = await prisma.run.findMany({
      where: { jobId: req.params.jobId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json(runs);
  });

  // "Run Now" (§2.1): creates a Run immediately, outside any Schedule,
  // and enqueues it with the same retry/backoff policy the scheduler
  // itself uses for a scheduled fire.
  router.post("/", requireAuth, requireJobAccess("EDIT"), async (req, res) => {
    const user = req.session.user!;
    const job = await prisma.job.findUnique({ where: { id: req.params.jobId } });
    if (!job) {
      res.status(404).json({ error: "job not found" });
      return;
    }

    const run = await prisma.run.create({
      data: {
        jobId: job.id,
        triggerType: "MANUAL",
        status: "PENDING",
      },
    });

    await queue.add("run", { runId: run.id } satisfies RunJobData, {
      attempts: job.maxRetries + 1,
      backoff: { type: "exponential", delay: 30_000 },
    });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "run.trigger_manual",
      targetType: "job",
      targetId: job.id,
      targetName: job.name,
      category: "lifecycle",
      result: "SUCCESS",
      details: { runId: run.id },
    });

    res.status(201).json(run);
  });

  return router;
}

// Mounted at /api/runs — run-id-scoped read access. Access is entirely
// inherited from the Run's Job's Project (requireRunAccess).
export function createRunsRouter(config: AppConfig): Router {
  const router = Router();

  router.get("/:id", requireAuth, requireRunAccess("READ"), async (req, res) => {
    const run = await prisma.run.findUnique({ where: { id: req.params.id } });
    res.json(run);
  });

  // On-demand PDF download (§2.5) — rendered fresh from already-persisted
  // data, never stored as a binary. Carries the same branding and
  // system-wide classification banner as the web UI, plus the source
  // Project's classification label (if any) as a secondary marking.
  router.get("/:id/pdf", requireAuth, requireRunAccess("READ"), async (req, res) => {
    const user = req.session.user!;
    const run = await prisma.run.findUnique({
      where: { id: req.params.id },
      include: {
        job: {
          include: { project: { include: { classificationLabel: true } } },
        },
      },
    });
    if (!run) {
      res.status(404).json({ error: "run not found" });
      return;
    }

    const settings = await getPublicAppSettings();
    const label = run.job.project.classificationLabel;

    const pdf = await requestRunReportPdf(config.PDF_SERVICE_URL, {
      productName: settings.productName,
      primaryColor: settings.primaryColor,
      banner: {
        text: settings.classificationBannerText,
        backgroundColor: settings.classificationBannerBgColor,
        textColor: settings.classificationBannerTextColor,
      },
      classification: label
        ? {
            text: label.abbreviation ? `${label.text} (${label.abbreviation})` : label.text,
            badgeBgColor: label.badgeBgColor,
            badgeTextColor: label.badgeTextColor,
          }
        : null,
      jobName: run.job.name,
      runId: run.id,
      triggerType: run.triggerType,
      status: run.status,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      promptTokens: run.promptTokens,
      completionTokens: run.completionTokens,
      computedCost: run.computedCost?.toString() ?? null,
      output: run.output,
      errorMessage: run.errorMessage,
    }, config.PDF_SERVICE_SHARED_SECRET);

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "run.pdf_download",
      targetType: "run",
      targetId: run.id,
      targetName: run.job.name,
      category: "data_access",
      result: "SUCCESS",
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="run-${run.id}.pdf"`);
    res.send(pdf);
  });

  return router;
}
