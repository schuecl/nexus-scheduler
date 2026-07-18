import { Registry, collectDefaultMetrics, Histogram, Gauge } from "prom-client";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "./db.js";

// Prometheus-compatible /metrics for platform operators (REQUIREMENTS
// §10/§11) — distinct from the user-facing Postgres audit trail/syslog
// mirror, which is product/compliance data, not cluster-ops telemetry.
// Run-level metrics (queue depth, running job count, run success/
// failure rates, LibreChat call latency) live on the Worker, which is
// where those events actually happen; the API's own contribution here
// is standard HTTP request telemetry plus Node's default process
// metrics (event loop lag, memory, GC).
export function createMetrics() {
  const register = new Registry();
  collectDefaultMetrics({ register });

  const httpRequestDuration = new Histogram({
    name: "nexus_scheduler_http_request_duration_seconds",
    help: "Duration of HTTP requests handled by the API",
    labelNames: ["method", "route", "status_code"] as const,
    registers: [register],
  });


  // Same isolation pattern as the worker's queue-depth gauge: a slow or
  // unreachable Postgres must degrade one gauge, not the whole scrape —
  // register.metrics() awaits every collect(), and health.ts serves
  // /metrics through asyncHandler, so an unguarded rejection here turns
  // into a 500 for process/HTTP metrics too. On timeout or error the
  // gauge is left at its last-known value for this scrape.
  const guarded = (collect: (this: Gauge<string>) => Promise<void>) =>
    async function (this: Gauge<string>) {
    try {
      await Promise.race([
        collect.call(this),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("inventory collect timed out")), 2000),
        ),
      ]);
    } catch {
      // leave the gauge stale rather than failing the scrape
    }
  };

  // Inventory gauges — how much is *defined*, as opposed to the
  // worker's how much is *running*. Recomputed on scrape via collect()
  // (a handful of indexed COUNTs per scrape interval), so operators can
  // see jobs/schedules/keys at a glance and alert on drift (e.g.
  // schedules paused after an incident and never resumed).
  new Gauge({
    name: "nexus_scheduler_jobs",
    help: "Jobs currently defined",
    registers: [register],
    collect: guarded(async function (this: Gauge<string>) {
      this.set(await prisma.job.count());
    }),
  });

  new Gauge({
    name: "nexus_scheduler_schedules",
    help: "Schedules currently defined, by type and paused state",
    labelNames: ["type", "paused"] as const,
    registers: [register],
    collect: guarded(async function (this: Gauge<string>) {
      const rows = await prisma.schedule.groupBy({ by: ["type", "paused"], _count: { _all: true } });
      this.reset();
      for (const row of rows) {
        this.set({ type: row.type, paused: String(row.paused) }, row._count._all);
      }
    }),
  });

  new Gauge({
    name: "nexus_scheduler_api_keys",
    help: "LibreChat API keys stored, by status",
    labelNames: ["status"] as const,
    registers: [register],
    collect: guarded(async function (this: Gauge<string>) {
      const rows = await prisma.apiKey.groupBy({ by: ["status"], _count: { _all: true } });
      this.reset();
      for (const row of rows) {
        this.set({ status: row.status }, row._count._all);
      }
    }),
  });

  new Gauge({
    name: "nexus_scheduler_projects",
    help: "Projects currently defined",
    registers: [register],
    collect: guarded(async function (this: Gauge<string>) {
      this.set(await prisma.project.count());
    }),
  });

  new Gauge({
    name: "nexus_scheduler_prompts",
    help: "Prompts currently defined",
    registers: [register],
    collect: guarded(async function (this: Gauge<string>) {
      this.set(await prisma.prompt.count());
    }),
  });

  return { register, httpRequestDuration };
}

export type Metrics = ReturnType<typeof createMetrics>;

// Records one observation per request, using the matched Express route
// pattern (e.g. "/api/jobs/:id") rather than the raw URL, so metrics
// don't fan out into one series per distinct ID.
//
// req.route.path is the pattern within the innermost router, but for a
// router mounted with a param in its own mount path (e.g.
// "/api/projects/:projectId/jobs", mergeParams: true) req.baseUrl is
// already resolved — the id, not the pattern. Substitute req.params
// back in by name so the label stays bounded (#108).
function routeLabel(req: Request): string {
  if (!req.route?.path) {
    // No route matched (404) — req.path is the raw, attacker-controlled
    // URL and would otherwise blow the same cardinality budget the rest
    // of this function exists to protect.
    return "unmatched";
  }
  let base = req.baseUrl;
  for (const [name, value] of Object.entries(req.params)) {
    if (typeof value === "string" && value) {
      base = base.replace(`/${value}`, `/:${name}`);
    }
  }
  return `${base}${req.route.path}`;
}

export function metricsMiddleware(metrics: Metrics) {
  return (req: Request, res: Response, next: NextFunction) => {
    const stopTimer = metrics.httpRequestDuration.startTimer();
    res.on("finish", () => {
      stopTimer({ method: req.method, route: routeLabel(req), status_code: String(res.statusCode) });
    });
    next();
  };
}
