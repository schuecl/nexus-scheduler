import { Router } from "express";
import { createScheduleSchema, updateScheduleSchema, computeNextFireTime } from "@nexus-scheduler/shared";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireJobAccess } from "../middleware/requireJobAccess.js";
import { requireScheduleAccess } from "../middleware/requireScheduleAccess.js";
import { getAccessibleProjectIds, getEligibleApprovers } from "../access.js";
import { recordAuditEvent, diffChangedFields } from "../audit.js";

// Fields whose change re-triggers approval on an already-approved shared
// schedule (REQUIREMENTS.md §2.4: "target agent, prompt/prompt version,
// or timing; metadata-only edits ... do not require re-approval"). A
// Schedule doesn't carry the agent/prompt directly (its Job does), so in
// practice "substantive" here means the schedule's own timing/version-pin
// fields — Job-level changes are a separate object with its own audit
// trail (job.update).
const SUBSTANTIVE_FIELDS = ["runAt", "intervalConfig", "timezone", "versionPinMode", "pinnedPromptVersionId"] as const;

async function resolveNextFireAt(
  type: "ONE_TIME" | "RECURRING",
  runAt: string | undefined,
  intervalConfig: unknown,
  timezone: string,
): Promise<Date> {
  if (type === "ONE_TIME") {
    return new Date(runAt!);
  }
  // First occurrence is computed from "now" — REQUIREMENTS §2.4's
  // scheduling math (used identically by the Worker for subsequent
  // occurrences), so a freshly (re-)approved schedule fires on its
  // normal cadence rather than immediately.
  return computeNextFireTime(intervalConfig as never, timezone, new Date());
}

// Mounted at /api/jobs/:jobId/schedules (mergeParams).
export function createJobSchedulesRouter(): Router {
  const router = Router({ mergeParams: true });

  router.get("/", requireAuth, requireJobAccess("READ"), async (req, res) => {
    const schedules = await prisma.schedule.findMany({
      where: { jobId: req.params.jobId },
      orderBy: { createdAt: "desc" },
    });
    res.json(schedules);
  });

  router.post("/", requireAuth, requireJobAccess("EDIT"), async (req, res) => {
    const parsed = createScheduleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;
    const jobId = req.params.jobId!;

    // Fetched unconditionally (rather than only inside the
    // pinnedPromptVersionId branch, as before) since the audit event
    // below needs the Job's name as the schedule's targetName (§41) —
    // Schedule itself has no name field, only its parent Job does.
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (parsed.data.pinnedPromptVersionId) {
      const version = await prisma.promptVersion.findUnique({
        where: { id: parsed.data.pinnedPromptVersionId },
      });
      if (!version || version.promptId !== job?.promptId) {
        res.status(400).json({ error: "pinnedPromptVersionId must be a version of this Job's prompt" });
        return;
      }
    }

    // Private Projects don't need a second set of eyes; shared ones do
    // (REQUIREMENTS §2.4).
    const project = await prisma.project.findUnique({ where: { id: req.jobProjectId } });
    const needsApproval = project?.visibility === "SHARED";

    const nextFireAt = needsApproval
      ? null
      : await resolveNextFireAt(parsed.data.type, parsed.data.runAt, parsed.data.intervalConfig, parsed.data.timezone);

    const schedule = await prisma.schedule.create({
      data: {
        jobId,
        type: parsed.data.type,
        runAt: parsed.data.runAt ? new Date(parsed.data.runAt) : undefined,
        intervalConfig: parsed.data.intervalConfig,
        timezone: parsed.data.timezone,
        versionPinMode: parsed.data.versionPinMode,
        pinnedPromptVersionId: parsed.data.pinnedPromptVersionId,
        variableValues: parsed.data.variableValues,
        approvalStatus: needsApproval ? "PENDING" : "APPROVED",
        nextFireAt,
        createdById: user.id,
      },
    });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "schedule.create",
      targetType: "schedule",
      targetId: schedule.id,
      targetName: job?.name,
      category: "lifecycle",
      result: "SUCCESS",
      details: { approvalStatus: schedule.approvalStatus },
    });

    res.status(201).json(schedule);
  });

  return router;
}

// Mounted at /api/schedules.
export function createSchedulesRouter(): Router {
  const router = Router();

  router.get("/pending-approval", requireAuth, async (req, res) => {
    const user = req.session.user!;
    const isAdmin = user.role === "ADMIN";

    const candidates = await prisma.schedule.findMany({
      where: {
        approvalStatus: "PENDING",
        ...(isAdmin ? {} : { job: { projectId: { in: await getAccessibleProjectIds(user.id) } } }),
      },
      include: { job: { select: { id: true, name: true, projectId: true } } },
      orderBy: { createdAt: "asc" },
    });

    if (isAdmin) {
      res.json(candidates);
      return;
    }

    const eligible = [];
    for (const schedule of candidates) {
      const { userIds, orgWideEdit } = await getEligibleApprovers(schedule.job.projectId);
      if (orgWideEdit || userIds.has(user.id)) {
        eligible.push(schedule);
      }
    }
    res.json(eligible);
  });

  router.get("/:id", requireAuth, requireScheduleAccess("READ"), async (req, res) => {
    const schedule = await prisma.schedule.findUnique({ where: { id: req.params.id } });
    res.json(schedule);
  });

  router.patch("/:id", requireAuth, requireScheduleAccess("EDIT"), async (req, res) => {
    const parsed = updateScheduleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;
    const existing = await prisma.schedule.findUniqueOrThrow({ where: { id: req.params.id } });

    // createScheduleSchema enforces this same-prompt check on create, but
    // it's only Zod-level validation there — PATCH spreads parsed.data
    // straight into the update with nothing re-checking it, so without
    // this a user with EDIT on the schedule could pin any PromptVersion
    // UUID in the system, including one from a Project they can't access,
    // and read its content back via the run output once it fires.
    // Fetched unconditionally so the audit event below has the parent
    // Job's name as this schedule's targetName (§41) — Schedule itself
    // has no name field.
    const job = await prisma.job.findUnique({ where: { id: existing.jobId } });
    if (parsed.data.pinnedPromptVersionId) {
      const version = await prisma.promptVersion.findUnique({
        where: { id: parsed.data.pinnedPromptVersionId },
      });
      if (!version || version.promptId !== job?.promptId) {
        res.status(400).json({ error: "pinnedPromptVersionId must be a version of this Job's prompt" });
        return;
      }
    }

    const touchedSubstantive = SUBSTANTIVE_FIELDS.some((field) => field in parsed.data);
    const project = await prisma.project.findUnique({ where: { id: req.scheduleProjectId } });
    const mustReapprove =
      touchedSubstantive && project?.visibility === "SHARED" && existing.approvalStatus === "APPROVED";

    const merged = {
      type: existing.type,
      runAt: parsed.data.runAt ?? existing.runAt?.toISOString(),
      intervalConfig: parsed.data.intervalConfig ?? existing.intervalConfig,
      timezone: parsed.data.timezone ?? existing.timezone,
    };

    const schedule = await prisma.schedule.update({
      where: { id: req.params.id },
      data: {
        ...parsed.data,
        ...(mustReapprove
          ? { approvalStatus: "PENDING", nextFireAt: null }
          : touchedSubstantive && existing.approvalStatus === "APPROVED"
            ? { nextFireAt: await resolveNextFireAt(merged.type, merged.runAt, merged.intervalConfig, merged.timezone) }
            : {}),
      },
    });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "schedule.update",
      targetType: "schedule",
      targetId: schedule.id,
      targetName: job?.name,
      category: "lifecycle",
      changes: diffChangedFields(existing, schedule, Object.keys(parsed.data) as (keyof typeof existing)[]),
      result: "SUCCESS",
      details: { reapprovalTriggered: mustReapprove },
    });

    res.json(schedule);
  });

  router.delete("/:id", requireAuth, requireScheduleAccess("EDIT"), async (req, res) => {
    const user = req.session.user!;
    const schedule = await prisma.schedule.delete({ where: { id: req.params.id } });
    const job = await prisma.job.findUnique({ where: { id: schedule.jobId }, select: { name: true } });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "schedule.delete",
      targetType: "schedule",
      targetId: schedule.id,
      targetName: job?.name,
      category: "lifecycle",
      result: "SUCCESS",
    });

    res.status(204).send();
  });

  router.post("/:id/pause", requireAuth, requireScheduleAccess("EDIT"), async (req, res) => {
    const user = req.session.user!;
    const schedule = await prisma.schedule.update({ where: { id: req.params.id }, data: { paused: true } });
    const job = await prisma.job.findUnique({ where: { id: schedule.jobId }, select: { name: true } });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "schedule.pause",
      targetType: "schedule",
      targetId: schedule.id,
      targetName: job?.name,
      category: "lifecycle",
      result: "SUCCESS",
    });

    res.json(schedule);
  });

  router.post("/:id/resume", requireAuth, requireScheduleAccess("EDIT"), async (req, res) => {
    const user = req.session.user!;
    const existing = await prisma.schedule.findUniqueOrThrow({ where: { id: req.params.id } });

    // Resuming a schedule whose fire time has already passed while it
    // was paused shouldn't fire a backlog — recompute forward from now,
    // same "skip, don't catch up" spirit as the Worker's missed-fire
    // handling (§2.4).
    const nextFireAt =
      existing.approvalStatus === "APPROVED"
        ? await resolveNextFireAt(
            existing.type,
            existing.runAt?.toISOString(),
            existing.intervalConfig,
            existing.timezone,
          )
        : existing.nextFireAt;

    const schedule = await prisma.schedule.update({
      where: { id: req.params.id },
      data: { paused: false, nextFireAt },
    });
    const job = await prisma.job.findUnique({ where: { id: schedule.jobId }, select: { name: true } });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "schedule.resume",
      targetType: "schedule",
      targetId: schedule.id,
      targetName: job?.name,
      category: "lifecycle",
      result: "SUCCESS",
    });

    res.json(schedule);
  });

  router.post("/:id/approve", requireAuth, requireScheduleAccess("EDIT"), async (req, res) => {
    const user = req.session.user!;
    const existing = await prisma.schedule.findUniqueOrThrow({ where: { id: req.params.id } });

    if (existing.approvalStatus !== "PENDING") {
      res.status(409).json({ error: "schedule is not pending approval" });
      return;
    }

    if (user.role !== "ADMIN" && existing.createdById === user.id) {
      const { userIds, orgWideEdit } = await getEligibleApprovers(req.scheduleProjectId!);
      const others = new Set(userIds);
      others.delete(user.id);
      if (others.size > 0 || orgWideEdit) {
        res.status(403).json({
          error: "another eligible approver must approve this schedule (you authored it)",
        });
        return;
      }
    }

    const nextFireAt = await resolveNextFireAt(
      existing.type,
      existing.runAt?.toISOString(),
      existing.intervalConfig,
      existing.timezone,
    );

    const schedule = await prisma.schedule.update({
      where: { id: req.params.id },
      data: { approvalStatus: "APPROVED", nextFireAt },
    });
    const [job, submitter] = await Promise.all([
      prisma.job.findUnique({ where: { id: schedule.jobId }, select: { name: true } }),
      prisma.user.findUnique({ where: { id: existing.createdById }, select: { email: true } }),
    ]);

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "schedule.approve",
      targetType: "schedule",
      targetId: schedule.id,
      targetName: job?.name,
      // The submitter (whoever created/requested this schedule) is the
      // affected second principal for an approval (§41) — distinct from
      // the approver, who is the actor.
      subjectType: "user",
      subjectId: existing.createdById,
      subjectName: submitter?.email,
      category: "governance",
      result: "SUCCESS",
    });

    res.json(schedule);
  });

  router.post("/:id/reject", requireAuth, requireScheduleAccess("EDIT"), async (req, res) => {
    const user = req.session.user!;
    const existing = await prisma.schedule.findUniqueOrThrow({ where: { id: req.params.id } });

    if (existing.approvalStatus !== "PENDING") {
      res.status(409).json({ error: "schedule is not pending approval" });
      return;
    }

    if (user.role !== "ADMIN" && existing.createdById === user.id) {
      const { userIds, orgWideEdit } = await getEligibleApprovers(req.scheduleProjectId!);
      const others = new Set(userIds);
      others.delete(user.id);
      if (others.size > 0 || orgWideEdit) {
        res.status(403).json({
          error: "another eligible approver must review this schedule (you authored it)",
        });
        return;
      }
    }

    const schedule = await prisma.schedule.update({
      where: { id: req.params.id },
      data: { approvalStatus: "REJECTED" },
    });
    const [job, submitter] = await Promise.all([
      prisma.job.findUnique({ where: { id: schedule.jobId }, select: { name: true } }),
      prisma.user.findUnique({ where: { id: existing.createdById }, select: { email: true } }),
    ]);

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "schedule.reject",
      targetType: "schedule",
      targetId: schedule.id,
      targetName: job?.name,
      subjectType: "user",
      subjectId: existing.createdById,
      subjectName: submitter?.email,
      category: "governance",
      result: "SUCCESS",
    });

    res.json(schedule);
  });

  return router;
}
