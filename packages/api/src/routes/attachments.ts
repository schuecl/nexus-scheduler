import express, { Router } from "express";
import {
  createAttachmentSchema,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_JOB,
  MAX_JOB_ATTACHMENT_TOTAL_BYTES,
} from "@nexus-scheduler/shared";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireJobAccess } from "../middleware/requireJobAccess.js";
import { recordAuditEvent } from "../audit.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

// Mounted at /api/jobs/:jobId/attachments (mergeParams) — same access
// convention as Runs/Schedules: READ to list, EDIT to add/remove
// (REQUIREMENTS §2.1). Files attached here are OCR'd by the worker
// before every run (#109); the raw file never leaves this system.
export function createJobAttachmentsRouter(): Router {
  const router = Router({ mergeParams: true });

  router.get("/", requireAuth, requireJobAccess("READ"), asyncHandler(async (req, res) => {
    const attachments = await prisma.jobAttachment.findMany({
      where: { jobId: req.params.jobId },
      // data is deliberately not selected — listing must stay cheap.
      select: { id: true, filename: true, mimeType: true, sizeBytes: true, createdById: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    res.json(attachments);
  }));

  // The 21mb parser sits AFTER auth/access on purpose: only an
  // authenticated EDIT-holder on this job can make the server buffer a
  // large body (the global parser skips this path — app.ts).
  router.post("/", requireAuth, requireJobAccess("EDIT"), express.json({ limit: "21mb" }), asyncHandler(async (req, res) => {
    const parsed = createAttachmentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const data = Buffer.from(parsed.data.dataBase64, "base64");
    if (data.length === 0) {
      res.status(400).json({ error: "dataBase64 decoded to zero bytes" });
      return;
    }
    if (data.length > MAX_ATTACHMENT_BYTES) {
      res.status(413).json({ error: `attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
      return;
    }
    const jobId = req.params.jobId!;
    // Per-job quota: the 15MB per-request cap alone would let a job
    // accumulate unbounded rows; the worker OCRs every attachment on
    // every run, so both count and aggregate bytes must stay bounded.
    // Check and insert share one transaction holding a per-job advisory
    // lock — without it, N concurrent uploads all pass the check before
    // any insert commits and the quota is a suggestion.
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${jobId}))`;
      const existing = await tx.jobAttachment.aggregate({
        where: { jobId },
        _count: true,
        _sum: { sizeBytes: true },
      });
      if (existing._count >= MAX_ATTACHMENTS_PER_JOB) {
        return { error: 409 as const };
      }
      if ((existing._sum.sizeBytes ?? 0) + data.length > MAX_JOB_ATTACHMENT_TOTAL_BYTES) {
        return { error: 413 as const };
      }
      const created = await tx.jobAttachment.create({
        data: {
          jobId,
          filename: parsed.data.filename,
          mimeType: parsed.data.mimeType,
          sizeBytes: data.length,
          data,
          createdById: req.session.user!.id,
        },
        select: { id: true, filename: true, mimeType: true, sizeBytes: true, createdAt: true },
      });
      return { created };
    });
    if ("error" in outcome) {
      if (outcome.error === 409) {
        res.status(409).json({ error: `job already has ${MAX_ATTACHMENTS_PER_JOB} attachments (limit)` });
      } else {
        res.status(413).json({ error: `job attachments would exceed ${MAX_JOB_ATTACHMENT_TOTAL_BYTES} bytes total` });
      }
      return;
    }
    const attachment = outcome.created;
    const user = req.session.user!;
    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "job.attachment_add",
      targetType: "job",
      targetId: req.params.jobId,
      targetName: parsed.data.filename,
      category: "lifecycle",
      result: "SUCCESS",
      details: { mimeType: parsed.data.mimeType, sizeBytes: data.length },
    });
    res.status(201).json(attachment);
  }));

  router.delete("/:attachmentId", requireAuth, requireJobAccess("EDIT"), asyncHandler(async (req, res) => {
    const existing = await prisma.jobAttachment.findFirst({
      where: { id: req.params.attachmentId, jobId: req.params.jobId },
      select: { id: true, filename: true },
    });
    if (!existing) {
      res.status(404).json({ error: "attachment not found" });
      return;
    }
    await prisma.jobAttachment.delete({ where: { id: existing.id } });
    const user = req.session.user!;
    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "job.attachment_remove",
      targetType: "job",
      targetId: req.params.jobId,
      targetName: existing.filename,
      category: "lifecycle",
      result: "SUCCESS",
    });
    res.status(204).end();
  }));

  return router;
}
