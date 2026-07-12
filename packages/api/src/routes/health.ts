import { Router } from "express";
import { prisma } from "../db.js";

// Kubernetes liveness/readiness probes — REQUIREMENTS.md §10/§11.
// Liveness only proves the process is alive; readiness proves it can
// actually reach its dependencies, so don't collapse these into one.
export function createHealthRouter(): Router {
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

  // TODO: replace with a real Prometheus registry (prom-client) once
  // the metrics this app should expose (§10: queue depth, running job
  // count, success/failure rates, LibreChat call latency) are wired up.
  router.get("/metrics", (_req, res) => {
    res.status(200).type("text/plain").send("# metrics not yet implemented\n");
  });

  return router;
}
