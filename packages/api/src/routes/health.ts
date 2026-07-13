import { Router } from "express";
import { prisma } from "../db.js";
import type { Metrics } from "../metrics.js";

// Kubernetes liveness/readiness probes — REQUIREMENTS.md §10/§11.
// Liveness only proves the process is alive; readiness proves it can
// actually reach its dependencies, so don't collapse these into one.
export function createHealthRouter(metrics: Metrics): Router {
  const router = Router();

  router.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  router.get("/readyz", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.status(200).json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "not ready" });
    }
  });

  router.get("/metrics", async (_req, res) => {
    res.status(200).type(metrics.register.contentType).send(await metrics.register.metrics());
  });

  return router;
}
