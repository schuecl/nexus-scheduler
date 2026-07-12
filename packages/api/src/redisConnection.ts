import type { ConnectionOptions } from "bullmq";

// Same rationale as packages/worker/src/redisConnection.ts: BullMQ bundles
// its own ioredis version internally, so a Redis instance created from our
// own top-level `ioredis` dependency (used for the session store) would be
// a structural type mismatch. Plain connection options sidestep that.
export function parseRedisConnectionOptions(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    tls: url.protocol === "rediss:" ? {} : undefined,
  };
}
