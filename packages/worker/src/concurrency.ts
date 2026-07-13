import type { RedisClient } from "bullmq";

// BullMQ's own RedisClient type is a narrow, hand-curated interface
// covering only the commands BullMQ itself uses internally — the
// actual runtime object (an ioredis Redis/Cluster instance, reused via
// worker.client rather than opening a second connection) really does
// support eval/zrem, just not declared in that narrower type.
interface RawCommandClient {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  zrem(key: string, ...members: string[]): Promise<number>;
}

// Per-user concurrency limiting (REQUIREMENTS §2.1: default 5,
// admin-configurable) — BullMQ's open-source Worker only supports a
// single *global* concurrency ceiling natively, so this layers a
// Redis-backed semaphore on top, keyed by the Job's owner (the only
// "user" identity available on every Run regardless of trigger type —
// scheduled or manual).
//
// Implemented as a sorted set per user: member = runId, score = the
// slot's expiry timestamp (now + ttlMs). This self-heals if a worker
// process crashes mid-run without ever releasing its slot — a plain
// INCR/DECR counter would leak that slot forever, permanently
// shrinking that user's effective limit. Expired members are pruned
// atomically as part of every acquire attempt, so no separate cleanup
// job is needed.
const KEY_PREFIX = "nexus:concurrency:user:";

// Atomic prune-check-add in one round trip: without this, two
// concurrent acquire attempts for the same user could both read the
// same (under-limit) count before either adds its member, letting the
// limit be exceeded by however many callers raced the check.
const ACQUIRE_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local current = redis.call('ZCARD', KEYS[1])
if current >= tonumber(ARGV[2]) then
  return 0
end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
return 1
`;

export async function tryAcquireUserSlot(
  client: RedisClient,
  userId: string,
  runId: string,
  limit: number,
  ttlMs: number,
): Promise<boolean> {
  const raw = client as unknown as RawCommandClient;
  const now = Date.now();
  const result = await raw.eval(ACQUIRE_SCRIPT, 1, `${KEY_PREFIX}${userId}`, now, limit, now + ttlMs, runId);
  return result === 1;
}

export async function releaseUserSlot(client: RedisClient, userId: string, runId: string): Promise<void> {
  const raw = client as unknown as RawCommandClient;
  await raw.zrem(`${KEY_PREFIX}${userId}`, runId);
}
