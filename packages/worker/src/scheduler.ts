import type { Queue } from "bullmq";
import { computeNextFireTime, intervalConfigSchema } from "@nexus-scheduler/shared";
import { prisma } from "./db.js";
import type { RunJobData } from "./queue.js";
import type { Logger } from "./logger.js";
import type { WorkerConfig } from "./config.js";

// Polls Postgres for due schedules and enqueues runs. REQUIREMENTS.md
// §2.4: a fire time missed because the worker was down is *skipped*, not
// caught up — anything more than ~2 ticks overdue is treated as missed
// rather than fired late, so an outage doesn't cause a burst of stale runs.
export function startSchedulerLoop(
  queue: Queue<RunJobData>,
  config: WorkerConfig,
  logger: Logger,
): NodeJS.Timeout {
  const missedFireToleranceMs = config.SCHEDULER_TICK_MS * 2;

  const tick = async () => {
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

        if (missed) {
          await prisma.run.create({
            data: {
              jobId: schedule.jobId,
              scheduleId: schedule.id,
              triggerType: "SCHEDULED",
              status: "SKIPPED",
            },
          });
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

        if (schedule.type === "ONE_TIME") {
          await prisma.schedule.update({
            where: { id: schedule.id },
            data: { nextFireAt: null, paused: true },
          });
        } else {
          const intervalConfig = intervalConfigSchema.parse(schedule.intervalConfig);
          const next = computeNextFireTime(intervalConfig, schedule.timezone, schedule.nextFireAt ?? now);
          await prisma.schedule.update({
            where: { id: schedule.id },
            data: { nextFireAt: next },
          });
        }
      }
    } catch (err) {
      logger.error({ err }, "scheduler tick failed");
    }
  };

  const interval = setInterval(tick, config.SCHEDULER_TICK_MS);
  void tick(); // run once immediately at startup rather than waiting a full tick
  return interval;
}
