import { Router } from "express";
import { Prisma } from "@nexus-scheduler/shared/prisma";
import { createCostRateSchema, updateCostRateSchema } from "@nexus-scheduler/shared";
import { prisma } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/requireAuth.js";
import { recordAuditEvent, diffChangedFields } from "../audit.js";

function isNotFoundError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";
}

function isConflictError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

// Internal cost-computation rates (§8) — the Worker's costCalculator.ts
// has consumed these since the Usage & Reporting work, but there was no
// way to actually create one, so every run's cost was "not costed."
export function createCostRatesRouter(): Router {
  const router = Router();

  router.get("/", requireAuth, requireAdmin, async (_req, res) => {
    const rates = await prisma.costRate.findMany({ orderBy: [{ agentId: "asc" }, { effectiveFrom: "desc" }] });
    res.json(rates);
  });

  router.post("/", requireAuth, requireAdmin, async (req, res, next) => {
    const parsed = createCostRateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;

    let rate;
    try {
      rate = await prisma.costRate.create({
        data: {
          agentId: parsed.data.agentId,
          promptRatePerMillion: parsed.data.promptRatePerMillion,
          completionRatePerMillion: parsed.data.completionRatePerMillion,
          effectiveFrom: parsed.data.effectiveFrom ? new Date(parsed.data.effectiveFrom) : undefined,
        },
      });
    } catch (err) {
      if (isConflictError(err)) {
        res.status(409).json({ error: "a rate for this agent already has this exact effective date" });
        return;
      }
      next(err);
      return;
    }

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "cost_rate.create",
      targetType: "cost_rate",
      targetId: rate.id,
      targetName: rate.agentId ?? "(global default)",
      category: "admin",
      result: "SUCCESS",
      details: { promptRatePerMillion: parsed.data.promptRatePerMillion, completionRatePerMillion: parsed.data.completionRatePerMillion },
    });

    res.status(201).json(rate);
  });

  router.patch("/:id", requireAuth, requireAdmin, async (req, res, next) => {
    const parsed = updateCostRateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;
    const existing = await prisma.costRate.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      res.status(404).json({ error: "cost rate not found" });
      return;
    }

    let rate;
    try {
      rate = await prisma.costRate.update({
        where: { id: req.params.id },
        data: {
          ...parsed.data,
          effectiveFrom: parsed.data.effectiveFrom ? new Date(parsed.data.effectiveFrom) : undefined,
        },
      });
    } catch (err) {
      if (isNotFoundError(err)) {
        res.status(404).json({ error: "cost rate not found" });
        return;
      }
      if (isConflictError(err)) {
        res.status(409).json({ error: "a rate for this agent already has this exact effective date" });
        return;
      }
      next(err);
      return;
    }

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "cost_rate.update",
      targetType: "cost_rate",
      targetId: rate.id,
      targetName: rate.agentId ?? "(global default)",
      category: "admin",
      changes: diffChangedFields(existing, rate, Object.keys(parsed.data) as (keyof typeof existing)[]),
      result: "SUCCESS",
    });

    res.json(rate);
  });

  router.delete("/:id", requireAuth, requireAdmin, async (req, res, next) => {
    const user = req.session.user!;
    let rate;
    try {
      // Runs store their own computedCost at the time they ran, so
      // deleting a rate never retroactively changes past runs' costs —
      // it only affects rate lookups for future runs.
      rate = await prisma.costRate.delete({ where: { id: req.params.id } });
    } catch (err) {
      if (isNotFoundError(err)) {
        res.status(404).json({ error: "cost rate not found" });
        return;
      }
      next(err);
      return;
    }

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "cost_rate.delete",
      targetType: "cost_rate",
      targetId: rate.id,
      targetName: rate.agentId ?? "(global default)",
      category: "admin",
      result: "SUCCESS",
    });

    res.status(204).send();
  });

  return router;
}
