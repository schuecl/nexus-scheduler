import type { Queue } from "bullmq";
import { WORKER_HEARTBEAT_KEY, workerComponentStatusKey, WORKER_COMPONENT_STATUS_TTL_SECONDS } from "@nexus-scheduler/shared";
import type { RunJobData } from "./queue.js";
import type { Logger } from "./logger.js";
import type { WorkerConfig } from "./config.js";

// Same cast-through-the-narrow-BullMQ-type pattern concurrency.ts/
// cancellation.ts use for a command BullMQ's own RedisClient type
// doesn't declare — the runtime object really does support SET with an
// expiry, just not in that narrower type.
interface RawCommandClient {
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
}

// Live system map (issue #131): a component's true reachability is
// often only knowable from one side — nothing in this app calls
// LibreChat except the Worker, so the API (which serves the system
// status endpoint) has no way to probe it directly. The Worker
// publishes what it finds instead, with a TTL, so a crashed or scaled-
// to-zero worker degrades that link to "stale" rather than showing a
// last-known-good status that may no longer be true.
async function probeLibreChatReachable(baseUrl: string): Promise<boolean> {
  try {
    // Reachability only, not full health — even a 404/401 proves the
    // server answered. A non-2xx status is not treated as "down"; a
    // thrown network error (refused connection, DNS failure, timeout)
    // is the only thing that means unreachable.
    await fetch(baseUrl, { method: "GET", signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

// One publish pass. Exported standalone (mirrors runSchedulerTick/
// runOrphanReaperSweep) so a test can invoke it directly.
export async function publishComponentStatus(
  queue: Queue<RunJobData>,
  config: WorkerConfig,
  logger: Logger,
): Promise<void> {
  const redisClient = await queue.client;
  const raw = redisClient as unknown as RawCommandClient;

  const librechatUp = await probeLibreChatReachable(config.LIBRECHAT_BASE_URL);
  await raw
    .set(workerComponentStatusKey("librechat"), librechatUp ? "up" : "down", "EX", WORKER_COMPONENT_STATUS_TTL_SECONDS)
    .catch((err: unknown) => {
      logger.warn({ err }, "failed to publish LibreChat component status — will read as stale until it succeeds");
    });

  // A separate heartbeat, not just piggybacked on the LibreChat key:
  // colors the "Worker" node on the system map itself, independent of
  // whether the one external link it publishes happens to be reachable.
  await raw.set(WORKER_HEARTBEAT_KEY, "up", "EX", WORKER_COMPONENT_STATUS_TTL_SECONDS).catch((err: unknown) => {
    logger.warn({ err }, "failed to publish worker heartbeat — will read as stale until it succeeds");
  });
}

// Periodic loop, same setInterval + immediate-first-tick shape as
// startSchedulerLoop/startOrphanReaperLoop. No reentrancy guard: unlike
// those, an overlapping publish here can't produce a duplicate side
// effect (SET is idempotent), so the added complexity isn't worth it.
export function startComponentStatusPublisherLoop(
  queue: Queue<RunJobData>,
  config: WorkerConfig,
  logger: Logger,
): NodeJS.Timeout {
  const tick = () => {
    void publishComponentStatus(queue, config, logger).catch((err: unknown) => {
      logger.error({ err }, "component status publish failed");
    });
  };

  const interval = setInterval(tick, config.COMPONENT_STATUS_PUBLISH_INTERVAL_MS);
  tick();
  return interval;
}
