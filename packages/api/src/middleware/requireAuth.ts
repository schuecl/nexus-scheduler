import type { NextFunction, Request, Response } from "express";
import type { RoleName } from "@nexus-scheduler/shared";
import { canEdit, canManageSystem } from "@nexus-scheduler/shared";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.user) {
    res.status(401).json({ error: "authentication required" });
    return;
  }
  next();
}

export function requireEditor(req: Request, res: Response, next: NextFunction) {
  const role = req.session.user?.role;
  if (!role || !canEdit(role)) {
    res.status(403).json({ error: "editor or admin role required" });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const role = req.session.user?.role;
  if (!role || !canManageSystem(role)) {
    res.status(403).json({ error: "admin role required" });
    return;
  }
  next();
}

export function requireRole(role: RoleName) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.session.user?.role !== role) {
      res.status(403).json({ error: `${role} role required` });
      return;
    }
    next();
  };
}
