import type { Queue } from "bullmq";
import { computeNextFireTime, intervalConfigSchema, type IntervalConfig } from "@nexus-scheduler/shared";
import { prisma } from "./db.js";
import type { RunJobData } from "./queue.js";
import type { Logger } from "./logger.js";
import type { WorkerConfig } from "./config.js";
import type { Metrics } from "./metrics.js";

// computeNextFireTime only advances by a single interval from `base`. A
// schedule down for longer than one interval needs its nextFireAt rolled
// all the way forward past `now` in this same tick — otherwise every
// subsequent tick sees it as missed again, advances by just one interval,
// and emits one SKIPPED run per tick until the backlog finally clears
// (REQUIREMENTS §2.4's "skip missed fires" intent, not "skip one per tick
// forever"). The interval schema enforces a positive minimum step
// (minutes >= 5, hours >= 1, daily/weekly >= 1 day), so this always
// terminates; the iteration cap is a defense-in-depth guard against a
// future schema change accidentally allowing a non-advancing interval.
const MAX_CATCH_UP_ITERATIONS = 100_000;

function computeCaughtUpNextFireAt(
  intervalConfig: IntervalConfig,
  timezone: string,
  base: Date,
  now: Date,
): Date {
  let next = computeNextFireTime(intervalConfig, timezone, base);
  for (let i = 0; next <= now && i < MAX_CATCH_UP_ITERATIONS; i++) {
    next = computeNextFireTime(intervalConfig, timezone, next);
  }
  return next;
}

// One poll-Postgres-and-enqueue-due-runs pass. Exported (rather than
// kept as a closure private to startSchedulerLoop) so a test can invoke
// it directly — including firing two overlapping calls concurrently, to
// exercise the atomic-claim race protection described below without
// waiting on real setInterval timing (§51).
export async function runSchedulerTick(
  queue: Queue<RunJobData>,
  config: WorkerConfig,
  logger: Logger,
  metrics: Metrics,
): Promise<void> {
  const missedFireToleranceMs = config.SCHEDULER_TICK_MS * 2;

  const due = await prisma.schedule.findMany({
    where: {
      paused: false,
      approvalStatus: "APPROVED",
      nextFireAt: { lte: new Date() },
    },
    include: { job: true },
  });

  for (const schedule of due) {
    const now = new Date();
    const overdueMs = schedule.nextFireAt ? now.getTime() - schedule.nextFireAt.getTime() : 0;
    const missed = overdueMs > missedFireToleranceMs;

    // Atomically claim this fire by conditioning the nextFireAt advance
    // on the exact value just read: if another tick (an overlapping
    // call within this same process, or another worker replica) already
    // claimed this schedule, this UPDATE matches zero rows and we skip
    // it rather than creating a second Run for the same fire.
    const claimData =
      schedule.type === "ONE_TIME"
        ? { nextFireAt: null, paused: true }
        : {
            nextFireAt: computeCaughtUpNextFireAt(
              intervalConfigSchema.parse(schedule.intervalConfig),
              schedule.timezone,
              schedule.nextFireAt ?? now,
              now,
            ),
          };
    const claim = await prisma.schedule.updateMany({
      where: { id: schedule.id, nextFireAt: schedule.nextFireAt },
      data: claimData,
    });
    if (claim.count === 0) {
      continue;
    }

    if (missed) {
      await prisma.run.create({
        data: {
          jobId: schedule.jobId,
          scheduleId: schedule.id,
          triggerType: "SCHEDULED",
          status: "SKIPPED",
        },
      });
      metrics.runsTotal.inc({ status: "skipped" });
      logger.warn({ scheduleId: schedule.id, overdueMs }, "missed fire skipped");
    } else {
      const run = await prisma.run.create({
        data: {
          jobId: schedule.jobId,
          scheduleId: schedule.id,
          triggerType: "SCHEDULED",
          status: "PENDING",
        },
      });
      // Retry policy default (§2.1): N retries with exponential backoff
      // starting at 30s. BullMQ's `attempts` counts the initial try, so
      // maxRetries=2 -> attempts=3.
      await queue.add("run", { runId: run.id } satisfies RunJobData, {
        attempts: schedule.job.maxRetries + 1,
        backoff: { type: "exponential", delay: 30_000 },
      });
    }
  }
}

// Polls Postgres for due schedules and enqueues runs. REQUIREMENTS.md
// §2.4: a fire time missed because the worker was down is *skipped*, not
// caught up — anything more than ~2 ticks overdue is treated as missed
// rather than fired late, so an outage doesn't cause a burst of stale runs.
export function startSchedulerLoop(
  queue: Queue<RunJobData>,
  config: WorkerConfig,
  logger: Logger,
  metrics: Metrics,
): NodeJS.Timeout {
  // Reentrancy guard: setInterval doesn't wait for an async callback to
  // finish, so a tick that runs long (backlog, slow PG) would otherwise
  // overlap the next one, both reading the same due schedules. This
  // only protects a single process; the atomic claim inside
  // runSchedulerTick is what actually prevents duplicate runs, including
  // across multiple worker replicas (and is what's exercised directly,
  // bypassing this guard, by the concurrency regression test).
  let tickInProgress = false;

  const tick = async () => {
    if (tickInProgress) {
      logger.warn("previous scheduler tick still running, skipping this interval");
      return;
    }
    tickInProgress = true;
    try {
      await runSchedulerTick(queue, config, logger, metrics);
    } catch (err) {
      logger.error({ err }, "scheduler tick failed");
    } finally {
      tickInProgress = false;
    }
  };

  const interval = setInterval(tick, config.SCHEDULER_TICK_MS);
  void tick(); // run once immediately at startup rather than waiting a full tick
  return interval;
}
