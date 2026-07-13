import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from "prom-client";
import type { Queue } from "bullmq";
import type { RunJobData } from "./queue.js";

// Prometheus-compatible /metrics for platform operators (REQUIREMENTS
// §10/§11: queue depth, running job count, run success/failure rates,
// LibreChat call latency) — distinct from the user-facing Postgres
// audit trail / syslog mirror, which is product/compliance data, not
// cluster-ops telemetry.
export function createMetrics(queue: Queue<RunJobData>) {
  const register = new Registry();
  collectDefaultMetrics({ register });

  const runsTotal = new Counter({
    name: "nexus_scheduler_runs_total",
    help: "Total runs reaching a terminal state, by outcome",
    labelNames: ["status"] as const,
    registers: [register],
  });

  const librechatCallDuration = new Histogram({
    name: "nexus_scheduler_librechat_call_duration_seconds",
    help: "Duration of calls to LibreChat's Agents API",
    buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300],
    registers: [register],
  });

  // Pull-based: BullMQ's own job counts are queried live at scrape
  // time (via a Gauge `collect` callback) rather than tracked by hand
  // alongside every enqueue/dequeue, so this can never drift out of
  // sync with the queue's actual state. `active` here doubles as the
  // "running job count" REQUIREMENTS §10 asks for.
  //
  // Bounded with an explicit timeout: if Redis is unreachable,
  // ioredis/BullMQ's own retry behavior can leave getJobCounts()
  // hanging well past any reasonable scrape interval (confirmed by
  // testing against a dead Redis) — a stuck collect() here would hang
  // the entire /metrics response, taking down every other metric with
  // it, not just this one gauge. On timeout or any other error, this
  // gauge is just left at its last-known value for this scrape.
  const queueDepth = new Gauge({
    name: "nexus_scheduler_queue_depth",
    help: "Current BullMQ job counts by state",
    labelNames: ["state"] as const,
    registers: [register],
    async collect() {
      try {
        const counts = await Promise.race([
          queue.getJobCounts("waiting", "active", "delayed", "failed", "completed"),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("getJobCounts timed out")), 2000),
          ),
        ]);
        for (const [state, count] of Object.entries(counts)) {
          this.set({ state }, count);
        }
      } catch {
        // Redis unreachable or slow — leave this gauge stale rather
        // than blocking the rest of the /metrics response.
      }
    },
  });

  return { register, runsTotal, librechatCallDuration, queueDepth };
}

export type Metrics = ReturnType<typeof createMetrics>;
