import "dotenv/config";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createRunsQueue } from "./queue.js";
import { parseRedisConnectionOptions } from "./redisConnection.js";
import { startSchedulerLoop } from "./scheduler.js";
import { createRunProcessor } from "./processor.js";
import { startHealthServer } from "./health.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);

  const connection = parseRedisConnectionOptions(config.REDIS_URL);
  const queue = createRunsQueue(connection);

  startHealthServer(config, logger);
  startSchedulerLoop(queue, config, logger);
  const runWorker = createRunProcessor(connection, config, logger);

  runWorker.on("failed", (job, err) => {
    logger.error({ runId: job?.data.runId, err }, "run job failed permanently");
  });

  logger.info("nexus-scheduler worker started");

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, async () => {
      logger.info({ signal }, "shutting down worker");
      await runWorker.close();
      await queue.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal startup error", err);
  process.exit(1);
});
