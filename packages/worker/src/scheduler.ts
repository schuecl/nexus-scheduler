import type { Queue } from "bullmq";
import { computeNextFireTime, intervalConfigSchema } from "@nexus-scheduler/shared";
import { prisma } from "./db.js";
import type { RunJobData } from "./queue.js";
import type { Logger } from "./logger.js";
import type { WorkerConfig } from "./config.js";
import type { Metrics } from "./metrics.js";

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
  const missedFireToleranceMs = config.SCHEDULER_TICK_MS * 2;

  // Reentrancy guard: setInterval doesn't wait for an async callback to
  // finish, so a tick that runs long (backlog, slow PG) would otherwise
  // overlap the next one, both reading the same due schedules. This
  // only protects a single process; the atomic claim below is what
  // actually prevents duplicate runs, including across multiple worker
  // replicas.
  let tickInProgress = false;

  const tick = async () => {
    if (tickInProgress) {
      logger.warn("previous scheduler tick still running, skipping this interval");
      return;
    }
    tickInProgress = true;
    try {
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

        // Atomically claim this fire by conditioning the nextFireAt
        // advance on the exact value just read: if another tick (this
        // process overlapping itself despite the guard above, or
        // another worker replica) already claimed this schedule, this
        // UPDATE matches zero rows and we skip it rather than creating
        // a second Run for the same fire.
        const claimData =
          schedule.type === "ONE_TIME"
            ? { nextFireAt: null, paused: true }
            : {
                nextFireAt: computeNextFireTime(
                  intervalConfigSchema.parse(schedule.intervalConfig),
                  schedule.timezone,
                  schedule.nextFireAt ?? now,
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
          // Retry policy default (§2.1): N retries with exponential
          // backoff starting at 30s. BullMQ's `attempts` counts the
          // initial try, so maxRetries=2 -> attempts=3.
          await queue.add("run", { runId: run.id } satisfies RunJobData, {
            attempts: schedule.job.maxRetries + 1,
            backoff: { type: "exponential", delay: 30_000 },
          });
        }
      }
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
