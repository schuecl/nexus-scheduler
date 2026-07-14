import { Router } from "express";
import {
  createTeamSchema,
  updateTeamSchema,
  addTeamMemberSchema,
  updateTeamMembershipSchema,
} from "@nexus-scheduler/shared";
import { prisma } from "../db.js";
import { requireAuth, requireEditor } from "../middleware/requireAuth.js";
import { requireTeamAccess } from "../middleware/requireTeamAccess.js";
import { recordAuditEvent, diffChangedFields } from "../audit.js";
import { getDescendantTeamIds } from "../access.js";

// Teams are local-only, UI-managed groups used purely as a Project ACL
// sharing target (REQUIREMENTS.md §2.3/§4) — not sourced from Keycloak,
// not tied to roles/permissions. Every Team has one or more owners (the
// creator, by default) who can rename/reparent/delete it and manage its
// membership; plain members can only see it. Admins bypass ownership
// entirely and can manage any Team.
export function createTeamsRouter(): Router {
  const router = Router();

  // `?mine=true` scopes the list to "Teams I belong to" — used by the
  // Teams management page. Without it, every Team in the org is
  // returned (to every authenticated user, unfiltered by admin status),
  // exactly as before this change: the Project-sharing "share with a
  // Team" picker and the API Key "Team-owned key" picker both depend on
  // seeing every Team, since sharing with or provisioning a key for a
  // Team you don't belong to is existing, working behavior neither of
  // those flows should lose. Admins always get every Team either way
  // (REQUIREMENTS §4: admins have full control over all Teams).
  router.get("/", requireAuth, async (req, res) => {
    const user = req.session.user!;
    const isAdmin = user.role === "ADMIN";
    const mineOnly = req.query.mine === "true" && !isAdmin;

    const teams = await prisma.team.findMany({
      where: mineOnly ? { memberships: { some: { userId: user.id } } } : undefined,
      orderBy: { name: "asc" },
      include: {
        _count: { select: { memberships: true, subTeams: true } },
        memberships: { where: { userId: user.id }, select: { isOwner: true } },
      },
    });

    res.json(
      teams.map(({ memberships, ...team }) => ({
        ...team,
        viewerIsOwner: isAdmin || memberships[0]?.isOwner === true,
      })),
    );
  });

  router.get("/:id", requireAuth, requireTeamAccess("MEMBER"), async (req, res) => {
    const team = await prisma.team.findUnique({
      where: { id: req.params.id },
      include: {
        memberships: { include: { user: { select: { id: true, email: true, displayName: true } } } },
        subTeams: { select: { id: true, name: true } },
        parentTeam: { select: { id: true, name: true } },
      },
    });
    if (!team) {
      res.status(404).json({ error: "team not found" });
      return;
    }
    res.json({ ...team, viewerIsOwner: req.teamAccess === "OWNER" });
  });

  router.post("/", requireAuth, requireEditor, async (req, res) => {
    const parsed = createTeamSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;

    if (parsed.data.parentTeamId) {
      const parent = await prisma.team.findUnique({ where: { id: parsed.data.parentTeamId } });
      if (!parent) {
        res.status(400).json({ error: "parentTeamId does not exist" });
        return;
      }
    }

    // The creator becomes the Team's first owner — otherwise a freshly
    // created Team would have no owner at all and only an admin could
    // ever touch it again.
    const team = await prisma.$transaction(async (tx) => {
      const created = await tx.team.create({ data: { ...parsed.data, createdById: user.id } });
      await tx.teamMembership.create({ data: { teamId: created.id, userId: user.id, isOwner: true } });
      return created;
    });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "team.create",
      targetType: "team",
      targetId: team.id,
      targetName: team.name,
      category: "lifecycle",
      result: "SUCCESS",
    });

    res.status(201).json(team);
  });

  router.patch("/:id", requireAuth, requireTeamAccess("OWNER"), async (req, res) => {
    const parsed = updateTeamSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;

    if (parsed.data.parentTeamId === req.params.id) {
      res.status(400).json({ error: "a team cannot be its own parent" });
      return;
    }
    if (parsed.data.parentTeamId) {
      const descendantIds = await getDescendantTeamIds(req.params.id!);
      if (descendantIds.includes(parsed.data.parentTeamId)) {
        res.status(400).json({ error: "a team cannot be reparented under one of its own descendants" });
        return;
      }
    }

    const existing = await prisma.team.findUniqueOrThrow({ where: { id: req.params.id } });
    const team = await prisma.team.update({ where: { id: req.params.id }, data: parsed.data });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "team.update",
      targetType: "team",
      targetId: team.id,
      targetName: team.name,
      category: "lifecycle",
      changes: diffChangedFields(existing, team, Object.keys(parsed.data) as (keyof typeof existing)[]),
      result: "SUCCESS",
    });

    res.json(team);
  });

  router.delete("/:id", requireAuth, requireTeamAccess("OWNER"), async (req, res) => {
    const user = req.session.user!;
    const [subTeamCount, aclCount] = await Promise.all([
      prisma.team.count({ where: { parentTeamId: req.params.id } }),
      prisma.projectAcl.count({ where: { granteeTeamId: req.params.id } }),
    ]);
    if (subTeamCount > 0 || aclCount > 0) {
      res.status(409).json({
        error: "team has sub-teams or Project shares referencing it — reassign those first",
      });
      return;
    }

    const team = await prisma.team.delete({ where: { id: req.params.id } });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "team.delete",
      targetType: "team",
      targetId: team.id,
      targetName: team.name,
      category: "lifecycle",
      result: "SUCCESS",
    });

    res.status(204).send();
  });

  router.post("/:id/members", requireAuth, requireTeamAccess("OWNER"), async (req, res) => {
    const parsed = addTeamMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;

    // Always joins as a plain member — ownership is a deliberate,
    // separate promotion step (PATCH .../members/:userId), never
    // implicit on add.
    const [membership, team, addedUser] = await Promise.all([
      prisma.teamMembership.upsert({
        where: { teamId_userId: { teamId: req.params.id!, userId: parsed.data.userId } },
        create: { teamId: req.params.id!, userId: parsed.data.userId },
        update: {},
      }),
      prisma.team.findUnique({ where: { id: req.params.id }, select: { name: true } }),
      prisma.user.findUnique({ where: { id: parsed.data.userId }, select: { email: true } }),
    ]);

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "team.membership.add",
      targetType: "team",
      targetId: req.params.id,
      targetName: team?.name,
      subjectType: "user",
      subjectId: parsed.data.userId,
      subjectName: addedUser?.email,
      category: "authz_change",
      result: "SUCCESS",
    });

    res.status(201).json(membership);
  });

  // Promotes/demotes a member's owner status — blocked if it would
  // leave the Team with zero owners, since that's a state only an
  // admin could then recover from (same posture as this deployment
  // takes toward legacy pre-ownership Teams).
  router.patch("/:id/members/:userId", requireAuth, requireTeamAccess("OWNER"), async (req, res) => {
    const parsed = updateTeamMembershipSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;

    const membership = await prisma.teamMembership.findUnique({
      where: { teamId_userId: { teamId: req.params.id!, userId: req.params.userId! } },
    });
    if (!membership) {
      res.status(404).json({ error: "not a member of this team" });
      return;
    }

    if (!parsed.data.isOwner && membership.isOwner) {
      const ownerCount = await prisma.teamMembership.count({
        where: { teamId: req.params.id, isOwner: true },
      });
      if (ownerCount <= 1) {
        res.status(400).json({ error: "cannot remove the last owner — promote another member first" });
        return;
      }
    }

    const [updated, team, targetUser] = await Promise.all([
      prisma.teamMembership.update({
        where: { teamId_userId: { teamId: req.params.id!, userId: req.params.userId! } },
        data: { isOwner: parsed.data.isOwner },
      }),
      prisma.team.findUnique({ where: { id: req.params.id }, select: { name: true } }),
      prisma.user.findUnique({ where: { id: req.params.userId }, select: { email: true } }),
    ]);

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "team.membership.update",
      targetType: "team",
      targetId: req.params.id,
      targetName: team?.name,
      subjectType: "user",
      subjectId: req.params.userId,
      subjectName: targetUser?.email,
      category: "authz_change",
      // membership was fetched (and confirmed to exist) above, before
      // this update — its isOwner is the "from" side of the diff (§41),
      // otherwise a promotion and a demotion look identical in the log
      // (both just show the new isOwner value).
      changes:
        membership.isOwner !== updated.isOwner
          ? { isOwner: { from: membership.isOwner, to: updated.isOwner } }
          : undefined,
      result: "SUCCESS",
    });

    res.json(updated);
  });

  router.delete("/:id/members/:userId", requireAuth, requireTeamAccess("OWNER"), async (req, res) => {
    const user = req.session.user!;

    const membership = await prisma.teamMembership.findUnique({
      where: { teamId_userId: { teamId: req.params.id!, userId: req.params.userId! } },
    });
    if (!membership) {
      res.status(404).json({ error: "not a member of this team" });
      return;
    }
    if (membership.isOwner) {
      const ownerCount = await prisma.teamMembership.count({
        where: { teamId: req.params.id, isOwner: true },
      });
      if (ownerCount <= 1) {
        res.status(400).json({ error: "cannot remove the last owner — promote another member first" });
        return;
      }
    }

    const [, team, removedUser] = await Promise.all([
      prisma.teamMembership.delete({
        where: { teamId_userId: { teamId: req.params.id!, userId: req.params.userId! } },
      }),
      prisma.team.findUnique({ where: { id: req.params.id }, select: { name: true } }),
      prisma.user.findUnique({ where: { id: req.params.userId }, select: { email: true } }),
    ]);

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "team.membership.remove",
      targetType: "team",
      targetId: req.params.id,
      targetName: team?.name,
      subjectType: "user",
      subjectId: req.params.userId,
      subjectName: removedUser?.email,
      category: "authz_change",
      result: "SUCCESS",
    });

    res.status(204).send();
  });

  return router;
}
