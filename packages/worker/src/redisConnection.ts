import type { ConnectionOptions } from "bullmq";

// BullMQ bundles its own ioredis version internally; handing it a Redis
// instance created from our own top-level `ioredis` dependency causes a
// structural type mismatch between the two (different) ioredis versions.
// Passing plain connection options instead sidesteps that entirely and
// lets each Queue/Worker manage its own connection, which is BullMQ's
// documented default pattern.
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
