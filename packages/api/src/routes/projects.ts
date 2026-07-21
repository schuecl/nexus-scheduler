import { Router } from "express";
import {
  createProjectSchema,
  updateProjectSchema,
  grantProjectAclSchema,
  updateProjectAclSchema,
  transferProjectOwnershipSchema,
} from "@nexus-scheduler/shared";
import { prisma } from "../db.js";
import { requireAuth, requireEditor } from "../middleware/requireAuth.js";
import { requireProjectAccess } from "../middleware/requireProjectAccess.js";
import { listAccessibleProjects } from "../access.js";
import { recordAuditEvent, diffChangedFields } from "../audit.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

// Resolves a project ACL's grantee to a human-readable audit subject
// (§41) — update/revoke only have the raw granteeUserId/granteeTeamId
// from the (already-fetched-or-deleted) ACL row, unlike grant, which
// resolves this while validating the request body.
async function resolveAclGrantee(acl: {
  granteeType: "USER" | "TEAM" | "ORG";
  granteeUserId: string | null;
  granteeTeamId: string | null;
}): Promise<{ subjectType: string; subjectId?: string; subjectName?: string }> {
  if (acl.granteeType === "USER" && acl.granteeUserId) {
    const grantee = await prisma.user.findUnique({ where: { id: acl.granteeUserId }, select: { email: true } });
    return { subjectType: "user", subjectId: acl.granteeUserId, subjectName: grantee?.email };
  }
  if (acl.granteeType === "TEAM" && acl.granteeTeamId) {
    const grantee = await prisma.team.findUnique({ where: { id: acl.granteeTeamId }, select: { name: true } });
    return { subjectType: "team", subjectId: acl.granteeTeamId, subjectName: grantee?.name };
  }
  // ORG grants apply to the whole organization — there's no single
  // second principal to resolve.
  return { subjectType: "org", subjectName: "organization" };
}

// Resolves a batch of ACL rows' grantees to a human-readable label in
// two queries total (issue #228) — the list view previously rendered
// the raw granteeType ("USER"/"TEAM"), leaving an owner unable to tell
// *which* user or team a row actually grants access to without cross-
// referencing ids by hand. Deliberately not built on resolveAclGrantee
// above: that helper is one-row-at-a-time (fine for grant/update/revoke,
// which each resolve exactly one ACL for an audit event) and would be
// an N+1 query pattern here.
async function resolveAclGranteeLabels(
  acls: { id: string; granteeType: "USER" | "TEAM" | "ORG"; granteeUserId: string | null; granteeTeamId: string | null }[],
): Promise<Map<string, string>> {
  const userIds = [...new Set(acls.filter((a) => a.granteeUserId).map((a) => a.granteeUserId!))];
  const teamIds = [...new Set(acls.filter((a) => a.granteeTeamId).map((a) => a.granteeTeamId!))];
  const [users, teams] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, displayName: true } })
      : [],
    teamIds.length ? prisma.team.findMany({ where: { id: { in: teamIds } }, select: { id: true, name: true } }) : [],
  ]);
  const userLabel = new Map(users.map((u) => [u.id, u.displayName ?? u.email]));
  const teamLabel = new Map(teams.map((t) => [t.id, t.name]));
  const labels = new Map<string, string>();
  for (const acl of acls) {
    if (acl.granteeType === "USER") {
      labels.set(acl.id, (acl.granteeUserId && userLabel.get(acl.granteeUserId)) || "Unknown user");
    } else if (acl.granteeType === "TEAM") {
      labels.set(acl.id, (acl.granteeTeamId && teamLabel.get(acl.granteeTeamId)) || "Unknown team");
    } else {
      labels.set(acl.id, "Everyone in the organization");
    }
  }
  return labels;
}

// Projects are shared containers for prompts/jobs (REQUIREMENTS.md
// §2.3). Sharing config (the ACL sub-resource) is deliberately
// OWNER-only to view/mutate — "a Project owner can share a Project"
// (§2.3) — EDIT collaborators can change Project content but not decide
// who else gets access, to avoid uncontrolled privilege escalation.
export function createProjectsRouter(): Router {
  const router = Router();

  router.get("/", requireAuth, asyncHandler(async (req, res) => {
    const projects = await listAccessibleProjects(req.session.user!.id);
    res.json(projects);
  }));

  router.get("/:id", requireAuth, requireProjectAccess("READ"), asyncHandler(async (req, res) => {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: { classificationLabel: true, owner: { select: { id: true, email: true, displayName: true } } },
    });
    res.json({ ...project, effectiveAccess: req.projectAccess });
  }));

  router.post("/", requireAuth, requireEditor, asyncHandler(async (req, res) => {
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;

    let classificationLabelId = parsed.data.classificationLabelId;
    if (!classificationLabelId) {
      const defaultLabel = await prisma.classificationLabel.findFirst({ where: { isDefault: true } });
      classificationLabelId = defaultLabel?.id;
    }

    const project = await prisma.project.create({
      data: {
        name: parsed.data.name,
        description: parsed.data.description,
        classificationLabelId,
        ownerId: user.id,
      },
    });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "project.create",
      targetType: "project",
      targetId: project.id,
      targetName: project.name,
      category: "lifecycle",
      result: "SUCCESS",
    });

    res.status(201).json(project);
  }));

  router.patch("/:id", requireAuth, requireProjectAccess("EDIT"), asyncHandler(async (req, res) => {
    const parsed = updateProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;

    const existing = await prisma.project.findUniqueOrThrow({ where: { id: req.params.id } });
    const project = await prisma.project.update({ where: { id: req.params.id }, data: parsed.data });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "project.update",
      targetType: "project",
      targetId: project.id,
      targetName: project.name,
      category: "lifecycle",
      changes: diffChangedFields(existing, project, Object.keys(parsed.data) as (keyof typeof existing)[]),
      result: "SUCCESS",
    });

    res.json(project);
  }));

  router.delete("/:id", requireAuth, requireProjectAccess("OWNER"), asyncHandler(async (req, res) => {
    const user = req.session.user!;
    const project = await prisma.project.delete({ where: { id: req.params.id } });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "project.delete",
      targetType: "project",
      targetId: project.id,
      targetName: project.name,
      category: "lifecycle",
      result: "SUCCESS",
    });

    res.status(204).send();
  }));

  // Deliberately a separate, OWNER-gated action from PATCH /:id (which
  // only needs EDIT) — see transferProjectOwnershipSchema's comment for
  // why ownerId can't just be another field on the general update.
  // Doesn't touch ACLs: the previous owner keeps whatever access (if
  // any) they already had via an ACL grant, same as REQUIREMENTS'
  // existing sharing model — this is a handoff, not an automatic grant.
  router.post("/:id/transfer-ownership", requireAuth, requireProjectAccess("OWNER"), asyncHandler(async (req, res) => {
    const parsed = transferProjectOwnershipSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;

    const newOwner = await prisma.user.findUnique({ where: { id: parsed.data.newOwnerId } });
    if (!newOwner) {
      res.status(400).json({ error: "newOwnerId does not exist" });
      return;
    }

    // req.session.user isn't necessarily the *current* owner — an admin
    // can call this route too (requireProjectAccess grants admins
    // OWNER-equivalent access regardless of actual ownership) — so the
    // previous owner has to come from the Project row itself, not the
    // acting user.
    const previous = await prisma.project.findUniqueOrThrow({ where: { id: req.params.id } });

    const project = await prisma.project.update({
      where: { id: req.params.id },
      data: { ownerId: parsed.data.newOwnerId },
    });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "project.transfer_ownership",
      targetType: "project",
      targetId: project.id,
      targetName: project.name,
      subjectType: "user",
      subjectId: newOwner.id,
      subjectName: newOwner.email,
      category: "authz_change",
      changes: { ownerId: { from: previous.ownerId, to: newOwner.id } },
      result: "SUCCESS",
    });

    res.json(project);
  }));

  router.get("/:id/acl", requireAuth, requireProjectAccess("OWNER"), asyncHandler(async (req, res) => {
    const acls = await prisma.projectAcl.findMany({ where: { projectId: req.params.id } });
    const labels = await resolveAclGranteeLabels(acls);
    res.json(acls.map((acl) => ({ ...acl, granteeLabel: labels.get(acl.id) ?? acl.granteeType })));
  }));

  router.post("/:id/acl", requireAuth, requireProjectAccess("OWNER"), asyncHandler(async (req, res) => {
    const parsed = grantProjectAclSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;

    // Resolved once here and reused below for the audit event's subject
    // (§41) — previously fetched only to validate existence, then
    // discarded, leaving the grantee as a raw UUID in the audit trail.
    let subjectName: string | undefined = parsed.data.granteeType === "ORG" ? "organization" : undefined;
    if (parsed.data.granteeType === "USER") {
      const grantee = await prisma.user.findUnique({ where: { id: parsed.data.granteeUserId! } });
      if (!grantee) {
        res.status(400).json({ error: "granteeUserId does not exist" });
        return;
      }
      subjectName = grantee.email;
    }
    if (parsed.data.granteeType === "TEAM") {
      const grantee = await prisma.team.findUnique({ where: { id: parsed.data.granteeTeamId! } });
      if (!grantee) {
        res.status(400).json({ error: "granteeTeamId does not exist" });
        return;
      }
      subjectName = grantee.name;
    }

    const [acl, project] = await Promise.all([
      prisma.projectAcl.create({ data: { projectId: req.params.id!, ...parsed.data } }),
      prisma.project.update({
        // `visibility` is a display hint derived from ACL rows, not a
        // separate access-control source of truth — actual access is
        // always resolved from the ACL table via getProjectAccess().
        where: { id: req.params.id },
        data: { visibility: "SHARED" },
      }),
    ]);

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "project.acl.grant",
      targetType: "project",
      targetId: req.params.id,
      targetName: project.name,
      subjectType: parsed.data.granteeType.toLowerCase(),
      subjectId: parsed.data.granteeUserId ?? parsed.data.granteeTeamId,
      subjectName,
      category: "authz_change",
      result: "SUCCESS",
      details: { accessLevel: parsed.data.accessLevel },
    });

    res.status(201).json(acl);
  }));

  router.patch("/:id/acl/:aclId", requireAuth, requireProjectAccess("OWNER"), asyncHandler(async (req, res) => {
    const parsed = updateProjectAclSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;
    const before = await prisma.projectAcl.findUniqueOrThrow({ where: { id: req.params.aclId } });
    const [acl, project, subject] = await Promise.all([
      prisma.projectAcl.update({
        where: { id: req.params.aclId },
        data: { accessLevel: parsed.data.accessLevel },
      }),
      prisma.project.findUnique({ where: { id: req.params.id }, select: { name: true } }),
      resolveAclGrantee(before),
    ]);

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "project.acl.update",
      targetType: "project",
      targetId: req.params.id,
      targetName: project?.name,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      subjectName: subject.subjectName,
      category: "authz_change",
      changes:
        before.accessLevel !== acl.accessLevel
          ? { accessLevel: { from: before.accessLevel, to: acl.accessLevel } }
          : undefined,
      result: "SUCCESS",
      details: { aclId: acl.id },
    });

    res.json(acl);
  }));

  router.delete("/:id/acl/:aclId", requireAuth, requireProjectAccess("OWNER"), asyncHandler(async (req, res) => {
    const user = req.session.user!;
    const acl = await prisma.projectAcl.delete({ where: { id: req.params.aclId } });

    const [remaining, project, subject] = await Promise.all([
      prisma.projectAcl.count({ where: { projectId: req.params.id } }),
      prisma.project.findUnique({ where: { id: req.params.id }, select: { name: true } }),
      resolveAclGrantee(acl),
    ]);
    if (remaining === 0) {
      await prisma.project.update({ where: { id: req.params.id }, data: { visibility: "PRIVATE" } });
    }

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "project.acl.revoke",
      targetType: "project",
      targetId: req.params.id,
      targetName: project?.name,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      subjectName: subject.subjectName,
      category: "authz_change",
      result: "SUCCESS",
      details: { aclId: acl.id },
    });

    res.status(204).send();
  }));

  return router;
}
