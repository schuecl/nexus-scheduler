import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db.js";
import { getProjectAccess, type ProjectAccessLevel } from "../access.js";

const RANK: Record<Exclude<ProjectAccessLevel, null>, number> = { READ: 1, EDIT: 2, OWNER: 3 };

// A Run's access is inherited from its Job's Project, same chain as
// requireJobAccess/requireScheduleAccess (REQUIREMENTS.md §2.3). Runs are
// read-only from the API's perspective (created via schedule fire or
// run-now), so this is only ever used with minLevel "READ".
export function requireRunAccess(minLevel: "READ" | "EDIT" | "OWNER") {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = req.session.user;
    if (!user) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    const runId = req.params.id;
    if (!runId) {
      res.status(400).json({ error: "run id missing from route" });
      return;
    }

    const run = await prisma.run.findUnique({
      where: { id: runId },
      select: { jobId: true, job: { select: { projectId: true } } },
    });
    if (!run) {
      res.status(404).json({ error: "run not found" });
      return;
    }

    const access = await getProjectAccess(user.id, run.job.projectId);
    const effective = user.role === "ADMIN" ? "OWNER" : access;

    if (!effective || RANK[effective] < RANK[minLevel]) {
      res.status(access === null ? 404 : 403).json({ error: "insufficient project access" });
      return;
    }
    req.projectAccess = effective;
    next();
  };
}
