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

  // Labelled by the model that actually served the call (from the response —
  // requests carry `model: agentId`, so the request side cannot answer this)
  // and by outcome. Unlabelled, this histogram can say "model calls are slow"
  // but never "which model", which is the question that leads to an action
  // when several models serve different jobs.
  //
  // `model` is deliberately the only identifier here: it is bounded by the
  // models deployed. agentId/jobId/userId are user-created and unbounded — as
  // labels they would fan out one series per agent forever (see #108 for the
  // same mistake made in the API's route label).
  //
  // Buckets follow the job budget, not OpenTelemetry's GenAI convention. That
  // convention tops out at 81.92s, which suits interactive chat; here
  // DEFAULT_JOB_TIMEOUT_SECONDS is 600, so its buckets would dump every
  // agent run of consequence into +Inf and flatten the p95 exactly where the
  // timeout question is decided. The previous 300s ceiling had the same flaw
  // at half the scale: a run at 400s and a run at 599s were indistinguishable,
  // yet only one is nearly dead. The two buckets past the timeout exist to
  // show *how far* past it calls are landing.
  const librechatCallDuration = new Histogram({
    name: "nexus_scheduler_librechat_call_duration_seconds",
    help: "Duration of calls to LibreChat's Agents API, by serving model and outcome",
    labelNames: ["model", "outcome"] as const,
    buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 900],
    registers: [register],
  });

  // LibreChatError is raised and retried but never counted, so timeouts,
  // rate limits and upstream failures are invisible — they surface only as a
  // generic run failure, long after the useful signal is gone.
  const librechatErrorsTotal = new Counter({
    name: "nexus_scheduler_librechat_errors_total",
    help: "LibreChat Agents API call failures, by kind and serving model",
    labelNames: ["kind", "model"] as const,
    registers: [register],
  });

  // processor.ts already computes these per run and writes them to Postgres;
  // they were simply never exposed. Answering "what is this costing" via SQL
  // against the runs table means it cannot be alerted on or trended.
  const runTokensTotal = new Counter({
    name: "nexus_scheduler_run_tokens_total",
    help: "Tokens consumed by runs, by serving model and token type",
    labelNames: ["model", "type"] as const,
    registers: [register],
  });

  const runCostTotal = new Counter({
    name: "nexus_scheduler_run_cost_total",
    help: "Computed cost of runs, by serving model",
    labelNames: ["model"] as const,
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

  return {
    register,
    runsTotal,
    librechatCallDuration,
    librechatErrorsTotal,
    runTokensTotal,
    runCostTotal,
    queueDepth,
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
