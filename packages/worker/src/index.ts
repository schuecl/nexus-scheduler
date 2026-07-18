import "dotenv/config";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createRunsQueue } from "./queue.js";
import { parseRedisConnectionOptions } from "./redisConnection.js";
import { startSchedulerLoop } from "./scheduler.js";
import { createRunProcessor } from "./processor.js";
import { startHealthServer } from "./health.js";
import { createMetrics } from "./metrics.js";
import { startUsageReportLoop } from "./usageReportScheduler.js";
import { startCancellationSubscriber } from "./cancellation.js";
import { startOrphanReaperLoop } from "./orphanReaper.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);

  const connection = parseRedisConnectionOptions(config.REDIS_URL);
  const queue = createRunsQueue(connection);
  const metrics = createMetrics(queue);

  // Published from config rather than hardcoded in a dashboard, so the ceiling
  // drawn next to the throttle rate is the one this worker is actually
  // enforcing — a dashboard constant would silently drift the day someone
  // tunes the env var, which is exactly when the graph matters most.
  metrics.concurrencyLimit.set({ scope: "global" }, config.GLOBAL_MAX_CONCURRENT_RUNS);
  metrics.concurrencyLimit.set({ scope: "user" }, config.PER_USER_MAX_CONCURRENT_RUNS);

  startHealthServer(config, logger, metrics);
  startSchedulerLoop(queue, config, logger, metrics);
  const usageReportInterval = startUsageReportLoop(config, logger);
  const orphanReaperInterval = startOrphanReaperLoop(queue, config, logger, metrics);
  const runWorker = createRunProcessor(connection, config, logger, metrics);

  runWorker.on("failed", (job, err) => {
    logger.error({ runId: job?.data.runId, err }, "run job failed permanently");
  });

  const stopCancellationSubscriber = await startCancellationSubscriber(await runWorker.client, logger);

  logger.info("nexus-scheduler worker started");

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void (async () => {
        logger.info({ signal }, "shutting down worker");
        clearInterval(usageReportInterval);
        clearInterval(orphanReaperInterval);
        await stopCancellationSubscriber();
        await runWorker.close();
        await queue.close();
        process.exit(0);
      })();
    });
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal startup error", err);
  process.exit(1);
});
