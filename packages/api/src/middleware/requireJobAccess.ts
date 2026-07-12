import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db.js";
import { getProjectAccess, type ProjectAccessLevel } from "../access.js";

declare module "express-serve-static-core" {
  interface Request {
    jobProjectId?: string;
  }
}

const RANK: Record<Exclude<ProjectAccessLevel, null>, number> = { READ: 1, EDIT: 2, OWNER: 3 };

// Jobs, like Prompts, carry no ACLs of their own — access is entirely
// inherited from their Project (REQUIREMENTS.md §2.3).
export function requireJobAccess(minLevel: "READ" | "EDIT" | "OWNER") {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = req.session.user;
    if (!user) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    const jobId = req.params.jobId ?? req.params.id;
    if (!jobId) {
      res.status(400).json({ error: "job id missing from route" });
      return;
    }

    const job = await prisma.job.findUnique({ where: { id: jobId }, select: { projectId: true } });
    if (!job) {
      res.status(404).json({ error: "job not found" });
      return;
    }

    const access = await getProjectAccess(user.id, job.projectId);
    const effective = user.role === "ADMIN" ? "OWNER" : access;

    if (!effective || RANK[effective] < RANK[minLevel]) {
      res.status(access === null ? 404 : 403).json({ error: "insufficient project access" });
      return;
    }
    req.projectAccess = effective;
    req.jobProjectId = job.projectId;
    next();
  };
}
