import { Router } from "express";
import bcrypt from "bcryptjs";
import { updateUserSchema, createLocalUserSchema, adminSetPasswordSchema } from "@nexus-scheduler/shared";
import { prisma } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/requireAuth.js";
import { recordAuditEvent } from "../audit.js";
import { issuePasswordResetEmail } from "../passwordReset.js";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

const BCRYPT_ROUNDS = 12; // matches auth.ts's local-login/reset-password hashing cost

// Doubles as the read-only picker used when adding Team members/Project
// ACLs (any authenticated user, capped result set) and, for admins, the
// full user list backing role/active-status management (§4).
export function createUsersRouter(config: AppConfig, logger: Logger): Router {
  const router = Router();

  router.get("/", requireAuth, asyncHandler(async (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const isAdmin = req.session.user!.role === "ADMIN";
    const users = await prisma.user.findMany({
      where: search
        ? {
            OR: [
              { email: { contains: search, mode: "insensitive" } },
              { displayName: { contains: search, mode: "insensitive" } },
            ],
          }
        : undefined,
      select: { id: true, email: true, displayName: true, role: true, active: true, authSource: true },
      // Admin listing isn't paginated yet — fine well past REQUIREMENTS'
      // 500-user target, but real pagination is a follow-up if this
      // deployment's directory ends up much larger.
      take: isAdmin ? 1000 : 25,
      orderBy: { email: "asc" },
    });
    res.json(users);
  }));

  router.patch("/:id", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const admin = req.session.user!;

    if (req.params.id === admin.id && parsed.data.role && parsed.data.role !== "ADMIN") {
      res.status(400).json({ error: "cannot demote your own account" });
      return;
    }
    if (req.params.id === admin.id && parsed.data.active === false) {
      res.status(400).json({ error: "cannot deactivate your own account" });
      return;
    }

    // Fetched before the update so role/active changes can be logged as
    // a from->to diff (§41) — without this, a USER->ADMIN promotion (or
    // an active->inactive deactivation) only ever shows the new value,
    // with the prior one lost.
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: req.params.id },
      select: { role: true, active: true },
    });

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: parsed.data,
      select: { id: true, email: true, displayName: true, role: true, active: true, authSource: true },
    });

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (parsed.data.role !== undefined && parsed.data.role !== before.role) {
      changes.role = { from: before.role, to: user.role };
    }
    if (parsed.data.active !== undefined && parsed.data.active !== before.active) {
      changes.active = { from: before.active, to: user.active };
    }

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: admin.id,
      actorEmail: admin.email,
      action: "user.update",
      targetType: "user",
      targetId: user.id,
      targetName: user.email,
      category: "authz_change",
      changes: Object.keys(changes).length > 0 ? changes : undefined,
      result: "SUCCESS",
      details: parsed.data,
    });

    res.json(user);
  }));

  // Provisions a local account with no password set yet (§4) — the
  // account holder sets one via the same reset-password link this
  // immediately triggers, so there's never a temp password to
  // communicate out of band.
  router.post("/", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    if (!config.LOCAL_AUTH_ENABLED) {
      res.status(503).json({ error: "local accounts are disabled on this deployment" });
      return;
    }
    const parsed = createLocalUserSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const admin = req.session.user!;

    const existing = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    if (existing) {
      res.status(409).json({ error: "a user with that email already exists" });
      return;
    }

    const user = await prisma.user.create({
      data: {
        email: parsed.data.email,
        displayName: parsed.data.displayName,
        authSource: "LOCAL",
        role: parsed.data.role,
      },
    });

    await issuePasswordResetEmail(config, logger, user);

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: admin.id,
      actorEmail: admin.email,
      action: "user.create",
      targetType: "user",
      targetId: user.id,
      targetName: user.email,
      category: "admin",
      result: "SUCCESS",
      details: { authSource: "LOCAL", role: user.role },
    });

    res.status(201).json({ id: user.id, email: user.email, displayName: user.displayName, role: user.role });
  }));

  // Hard delete — blocked (409) if the user owns/created anything a
  // foreign key still points at (Projects, Jobs, Schedules, Prompt
  // versions, Teams), since Postgres has no cascade path for those and a
  // raw constraint violation isn't a useful error message. Team
  // memberships and personal API keys cascade cleanly and don't block
  // this. An admin wanting to remove access from a user with history
  // should use the "Active" toggle instead — REQUIREMENTS' audit trail
  // (§7) still needs actorId/actorEmail to mean something even after the
  // account is gone, which is exactly why AuditEvent doesn't have a real
  // FK to User in the first place.
  router.delete("/:id", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const admin = req.session.user!;

    if (req.params.id === admin.id) {
      res.status(400).json({ error: "cannot delete your own account" });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) {
      res.status(404).json({ error: "user not found" });
      return;
    }

    const [ownedProjects, jobsCreated, schedulesCreated, promptVersions, teamsCreated, jobsUsingOwnedKeys, attachmentsCreated] =
      await Promise.all([
        prisma.project.count({ where: { ownerId: user.id } }),
        prisma.job.count({ where: { createdById: user.id } }),
        prisma.schedule.count({ where: { createdById: user.id } }),
        prisma.promptVersion.count({ where: { createdById: user.id } }),
        prisma.team.count({ where: { createdById: user.id } }),
        // ApiKey.owningUser cascades on User delete, but Job.apiKey has
        // no onDelete (defaults to Restrict) — without this check, a
        // user whose personal key is still attached to a Job would pass
        // every check above and then fail with a raw FK violation once
        // the cascade tries to delete that key out from under the Job.
        prisma.job.count({ where: { apiKey: { ownerUserId: user.id } } }),
        // JobAttachment.createdBy is Restrict for the same reason —
        // without this count the delete dies on a raw FK violation
        // instead of the 409 this route promises.
        prisma.jobAttachment.count({ where: { createdById: user.id } }),
      ]);
    const blockers = ownedProjects + jobsCreated + schedulesCreated + promptVersions + teamsCreated + jobsUsingOwnedKeys + attachmentsCreated;
    if (blockers > 0) {
      res.status(409).json({
        error:
          jobsUsingOwnedKeys > 0 && ownedProjects + jobsCreated + schedulesCreated + promptVersions + teamsCreated + attachmentsCreated === 0
            ? "cannot delete — a Job still uses this user's personal API key; reassign or delete that Job first"
            : "cannot delete — this user owns or created Projects, Jobs, Schedules, Prompt versions, Teams, or Job attachments; deactivate the account instead",
      });
      return;
    }

    await prisma.user.delete({ where: { id: user.id } });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: admin.id,
      actorEmail: admin.email,
      action: "user.delete",
      targetType: "user",
      targetId: user.id,
      targetName: user.email,
      category: "admin",
      result: "SUCCESS",
    });

    res.status(204).send();
  }));

  router.post("/:id/send-password-reset", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const admin = req.session.user!;
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user || user.authSource !== "LOCAL") {
      res.status(400).json({ error: "not a local account" });
      return;
    }

    await issuePasswordResetEmail(config, logger, user);

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: admin.id,
      actorEmail: admin.email,
      action: "user.password_reset_sent",
      targetType: "user",
      targetId: user.id,
      targetName: user.email,
      category: "admin",
      result: "SUCCESS",
    });

    res.status(204).send();
  }));

  // Sets a local account's password directly, in-band — the complement
  // to send-password-reset's emailed link, for when SMTP isn't
  // configured (a real possibility in an air-gapped deployment) or an
  // admin just wants to hand the user a working password right now
  // rather than waiting on email delivery. Clears any pending reset
  // token so a stale emailed link can't still be used afterward.
  router.post("/:id/set-password", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const parsed = adminSetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const admin = req.session.user!;
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user || user.authSource !== "LOCAL") {
      res.status(400).json({ error: "not a local account" });
      return;
    }

    const passwordHash = await bcrypt.hash(parsed.data.newPassword, BCRYPT_ROUNDS);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, passwordResetTokenHash: null, passwordResetExpiresAt: null },
    });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: admin.id,
      actorEmail: admin.email,
      action: "user.password_set_by_admin",
      targetType: "user",
      targetId: user.id,
      targetName: user.email,
      category: "admin",
      result: "SUCCESS",
    });

    res.status(204).send();
  }));

  return router;
}
