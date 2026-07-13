import { Registry, collectDefaultMetrics, Histogram } from "prom-client";
import type { NextFunction, Request, Response } from "express";

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

  return { register, httpRequestDuration };
}

export type Metrics = ReturnType<typeof createMetrics>;

// Records one observation per request, using the matched Express route
// pattern (e.g. "/api/jobs/:id") rather than the raw URL, so metrics
// don't fan out into one series per distinct ID.
export function metricsMiddleware(metrics: Metrics) {
  return (req: Request, res: Response, next: NextFunction) => {
    const stopTimer = metrics.httpRequestDuration.startTimer();
    res.on("finish", () => {
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path;
      stopTimer({ method: req.method, route, status_code: String(res.statusCode) });
    });
    next();
  };
}
