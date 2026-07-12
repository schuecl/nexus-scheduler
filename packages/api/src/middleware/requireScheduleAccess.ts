import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db.js";
import { getProjectAccess, type ProjectAccessLevel } from "../access.js";

declare module "express-serve-static-core" {
  interface Request {
    scheduleJobId?: string;
    scheduleProjectId?: string;
  }
}

const RANK: Record<Exclude<ProjectAccessLevel, null>, number> = { READ: 1, EDIT: 2, OWNER: 3 };

// A Schedule's access is inherited from its Job's Project, same chain as
// requireJobAccess/requirePromptAccess (REQUIREMENTS.md §2.3).
export function requireScheduleAccess(minLevel: "READ" | "EDIT" | "OWNER") {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = req.session.user;
    if (!user) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    const scheduleId = req.params.id;
    if (!scheduleId) {
      res.status(400).json({ error: "schedule id missing from route" });
      return;
    }

    const schedule = await prisma.schedule.findUnique({
      where: { id: scheduleId },
      select: { jobId: true, job: { select: { projectId: true } } },
    });
    if (!schedule) {
      res.status(404).json({ error: "schedule not found" });
      return;
    }

    const access = await getProjectAccess(user.id, schedule.job.projectId);
    const effective = user.role === "ADMIN" ? "OWNER" : access;

    if (!effective || RANK[effective] < RANK[minLevel]) {
      res.status(access === null ? 404 : 403).json({ error: "insufficient project access" });
      return;
    }
    req.projectAccess = effective;
    req.scheduleJobId = schedule.jobId;
    req.scheduleProjectId = schedule.job.projectId;
    next();
  };
}
