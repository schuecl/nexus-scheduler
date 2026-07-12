import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db.js";
import { getProjectAccess, type ProjectAccessLevel } from "../access.js";

declare module "express-serve-static-core" {
  interface Request {
    promptProjectId?: string;
  }
}

const RANK: Record<Exclude<ProjectAccessLevel, null>, number> = { READ: 1, EDIT: 2, OWNER: 3 };

// Prompts don't carry their own ACLs — access is entirely inherited from
// the Project that contains them (REQUIREMENTS.md §2.3: "A saved prompt
// in a shared Project can be used... by any user with access to that
// Project"). This resolves the prompt's projectId, then delegates to the
// same getProjectAccess() used by requireProjectAccess so the two never
// disagree about who can see what.
export function requirePromptAccess(minLevel: "READ" | "EDIT" | "OWNER") {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = req.session.user;
    if (!user) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    const promptId = req.params.promptId ?? req.params.id;
    if (!promptId) {
      res.status(400).json({ error: "prompt id missing from route" });
      return;
    }

    const prompt = await prisma.prompt.findUnique({
      where: { id: promptId },
      select: { projectId: true },
    });
    if (!prompt) {
      res.status(404).json({ error: "prompt not found" });
      return;
    }

    const access = await getProjectAccess(user.id, prompt.projectId);
    const effective = user.role === "ADMIN" ? "OWNER" : access;

    if (!effective || RANK[effective] < RANK[minLevel]) {
      res.status(access === null ? 404 : 403).json({ error: "insufficient project access" });
      return;
    }
    req.projectAccess = effective;
    req.promptProjectId = prompt.projectId;
    next();
  };
}
