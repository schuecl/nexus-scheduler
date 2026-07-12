import { Router } from "express";
import { updateUserSchema } from "@nexus-scheduler/shared";
import { prisma } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/requireAuth.js";
import { recordAuditEvent } from "../audit.js";

// Doubles as the read-only picker used when adding Team members/Project
// ACLs (any authenticated user, capped result set) and, for admins, the
// full user list backing role/active-status management (§4).
export function createUsersRouter(): Router {
  const router = Router();

  router.get("/", requireAuth, async (req, res) => {
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
  });

  router.patch("/:id", requireAuth, requireAdmin, async (req, res) => {
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

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: parsed.data,
      select: { id: true, email: true, displayName: true, role: true, active: true, authSource: true },
    });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: admin.id,
      actorEmail: admin.email,
      action: "user.update",
      targetType: "user",
      targetId: user.id,
      targetName: user.email,
      result: "SUCCESS",
      details: parsed.data,
    });

    res.json(user);
  });

  return router;
}
