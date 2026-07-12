import { Router } from "express";
import { createCostRateSchema } from "@nexus-scheduler/shared";
import { prisma } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/requireAuth.js";
import { recordAuditEvent } from "../audit.js";

// Internal cost-computation rates (§8) — the Worker's costCalculator.ts
// has consumed these since the Usage & Reporting work, but there was no
// way to actually create one, so every run's cost was "not costed."
export function createCostRatesRouter(): Router {
  const router = Router();

  router.get("/", requireAuth, requireAdmin, async (_req, res) => {
    const rates = await prisma.costRate.findMany({ orderBy: [{ agentId: "asc" }, { effectiveFrom: "desc" }] });
    res.json(rates);
  });

  router.post("/", requireAuth, requireAdmin, async (req, res) => {
    const parsed = createCostRateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;

    const rate = await prisma.costRate.create({
      data: {
        agentId: parsed.data.agentId,
        promptRatePerMillion: parsed.data.promptRatePerMillion,
        completionRatePerMillion: parsed.data.completionRatePerMillion,
        effectiveFrom: parsed.data.effectiveFrom ? new Date(parsed.data.effectiveFrom) : undefined,
      },
    });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "cost_rate.create",
      targetType: "cost_rate",
      targetId: rate.id,
      targetName: rate.agentId ?? "(global default)",
      result: "SUCCESS",
      details: { promptRatePerMillion: parsed.data.promptRatePerMillion, completionRatePerMillion: parsed.data.completionRatePerMillion },
    });

    res.status(201).json(rate);
  });

  return router;
}
