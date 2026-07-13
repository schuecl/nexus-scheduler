import { Router } from "express";
import {
  createProjectSchema,
  updateProjectSchema,
  grantProjectAclSchema,
  updateProjectAclSchema,
} from "@nexus-scheduler/shared";
import { prisma } from "../db.js";
import { requireAuth, requireEditor } from "../middleware/requireAuth.js";
import { requireProjectAccess } from "../middleware/requireProjectAccess.js";
import { listAccessibleProjects } from "../access.js";
import { recordAuditEvent } from "../audit.js";

// Projects are shared containers for prompts/jobs (REQUIREMENTS.md
// §2.3). Sharing config (the ACL sub-resource) is deliberately
// OWNER-only to view/mutate — "a Project owner can share a Project"
// (§2.3) — EDIT collaborators can change Project content but not decide
// who else gets access, to avoid uncontrolled privilege escalation.
export function createProjectsRouter(): Router {
  const router = Router();

  router.get("/", requireAuth, async (req, res) => {
    const projects = await listAccessibleProjects(req.session.user!.id);
    res.json(projects);
  });

  router.get("/:id", requireAuth, requireProjectAccess("READ"), async (req, res) => {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: { classificationLabel: true, owner: { select: { id: true, email: true, displayName: true } } },
    });
    res.json({ ...project, effectiveAccess: req.projectAccess });
  });

  router.post("/", requireAuth, requireEditor, async (req, res) => {
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
      result: "SUCCESS",
    });

    res.status(201).json(project);
  });

  router.patch("/:id", requireAuth, requireProjectAccess("EDIT"), async (req, res) => {
    const parsed = updateProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;

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
      result: "SUCCESS",
      details: parsed.data,
    });

    res.json(project);
  });

  router.delete("/:id", requireAuth, requireProjectAccess("OWNER"), async (req, res) => {
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
      result: "SUCCESS",
    });

    res.status(204).send();
  });

  router.get("/:id/acl", requireAuth, requireProjectAccess("OWNER"), async (req, res) => {
    const acls = await prisma.projectAcl.findMany({ where: { projectId: req.params.id } });
    res.json(acls);
  });

  router.post("/:id/acl", requireAuth, requireProjectAccess("OWNER"), async (req, res) => {
    const parsed = grantProjectAclSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;

    if (parsed.data.granteeType === "USER") {
      const grantee = await prisma.user.findUnique({ where: { id: parsed.data.granteeUserId! } });
      if (!grantee) {
        res.status(400).json({ error: "granteeUserId does not exist" });
        return;
      }
    }
    if (parsed.data.granteeType === "TEAM") {
      const grantee = await prisma.team.findUnique({ where: { id: parsed.data.granteeTeamId! } });
      if (!grantee) {
        res.status(400).json({ error: "granteeTeamId does not exist" });
        return;
      }
    }

    const acl = await prisma.projectAcl.create({
      data: { projectId: req.params.id!, ...parsed.data },
    });
    // `visibility` is a display hint derived from ACL rows, not a
    // separate access-control source of truth — actual access is always
    // resolved from the ACL table via getProjectAccess().
    await prisma.project.update({ where: { id: req.params.id }, data: { visibility: "SHARED" } });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "project.acl.grant",
      targetType: "project",
      targetId: req.params.id,
      result: "SUCCESS",
      details: parsed.data,
    });

    res.status(201).json(acl);
  });

  router.patch("/:id/acl/:aclId", requireAuth, requireProjectAccess("OWNER"), async (req, res) => {
    const parsed = updateProjectAclSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;
    const acl = await prisma.projectAcl.update({
      where: { id: req.params.aclId },
      data: { accessLevel: parsed.data.accessLevel },
    });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "project.acl.update",
      targetType: "project",
      targetId: req.params.id,
      result: "SUCCESS",
      details: { aclId: acl.id, accessLevel: acl.accessLevel },
    });

    res.json(acl);
  });

  router.delete("/:id/acl/:aclId", requireAuth, requireProjectAccess("OWNER"), async (req, res) => {
    const user = req.session.user!;
    const acl = await prisma.projectAcl.delete({ where: { id: req.params.aclId } });

    const remaining = await prisma.projectAcl.count({ where: { projectId: req.params.id } });
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
      result: "SUCCESS",
      details: { aclId: acl.id, granteeType: acl.granteeType },
    });

    res.status(204).send();
  });

  return router;
}
