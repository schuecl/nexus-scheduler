import { Router } from "express";
import type { Redis } from "ioredis";
import { WORKER_HEARTBEAT_KEY, workerComponentStatusKey } from "@nexus-scheduler/shared";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import type { AppConfig } from "../config.js";

// Live system map (issue #131): "which components are set up, and which
// connections are working right now" — today that knowledge only lived
// across compose files, helm values, and log spelunking.
//
// Two kinds of node, probed two different ways:
// - Links the API itself owns/can reach directly (Postgres, Redis,
//   pdf-service) are probed synchronously, right here, on every request
//   — there's exactly one true reachability status per link regardless
//   of which process is asking, so nothing else needs to duplicate this.
// - The one link only the Worker can reach (LibreChat, plus the
//   Worker's own liveness) is published by the Worker into Redis under
//   a short TTL (componentStatusPublisher.ts) and just read back here.
//   A missing/expired key means "stale" — the Worker hasn't reported
//   recently, which is itself the signal (crashed, restarted, scaled to
//   zero), not "down" (which would claim to know something we don't).
export type ComponentStatus = "up" | "down" | "stale";

export interface SystemComponent {
  id: string;
  label: string;
  status: ComponentStatus;
}

export interface SystemStatusResponse {
  components: SystemComponent[];
  edges: Array<{ from: string; to: string }>;
  checkedAt: string;
}

async function probePostgres(): Promise<ComponentStatus> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return "up";
  } catch {
    return "down";
  }
}

async function probeRedis(redisClient: Redis): Promise<ComponentStatus> {
  try {
    await redisClient.ping();
    return "up";
  } catch {
    return "down";
  }
}

async function probePdfService(pdfServiceUrl: string): Promise<ComponentStatus> {
  try {
    const res = await fetch(new URL("/healthz", pdfServiceUrl), { signal: AbortSignal.timeout(5000) });
    return res.ok ? "up" : "down";
  } catch {
    return "down";
  }
}

// Reads a Worker-published key back as a status: present -> "up"/"down"
// (whatever the Worker wrote), absent/expired -> "stale". Never throws
// on a malformed value — an unrecognized string reads as stale rather
// than crashing the whole endpoint over one bad key.
async function readWorkerPublishedStatus(redisClient: Redis, key: string): Promise<ComponentStatus> {
  const value = await redisClient.get(key);
  return value === "up" || value === "down" ? value : "stale";
}

export function createSystemStatusRouter(config: AppConfig, redisClient: Redis): Router {
  const router = Router();

  router.get("/", requireAuth, asyncHandler(async (_req, res) => {
    const [postgres, redis, pdfService, librechat, worker] = await Promise.all([
      probePostgres(),
      probeRedis(redisClient),
      probePdfService(config.PDF_SERVICE_URL),
      readWorkerPublishedStatus(redisClient, workerComponentStatusKey("librechat")),
      readWorkerPublishedStatus(redisClient, WORKER_HEARTBEAT_KEY),
    ]);

    const response: SystemStatusResponse = {
      components: [
        // "api" itself is never probed — this endpoint answering at all
        // is the proof.
        { id: "api", label: "API", status: "up" },
        { id: "worker", label: "Worker", status: worker },
        { id: "postgres", label: "Postgres", status: postgres },
        { id: "redis", label: "Redis", status: redis },
        { id: "pdf-service", label: "PDF Service", status: pdfService },
        { id: "librechat", label: "LibreChat", status: librechat },
      ],
      edges: [
        { from: "api", to: "postgres" },
        { from: "api", to: "redis" },
        { from: "api", to: "pdf-service" },
        { from: "worker", to: "postgres" },
        { from: "worker", to: "redis" },
        { from: "worker", to: "pdf-service" },
        { from: "worker", to: "librechat" },
      ],
      checkedAt: new Date().toISOString(),
    };

    res.json(response);
  }));

  return router;
}
