import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HEALTH_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  API_KEY_ENCRYPTION_KEY: z.string().min(32),

  LIBRECHAT_BASE_URL: z.string().url(),

  // §2.1 concurrency/timeout defaults — admin-configurable in the DB
  // eventually; env vars are the bootstrap default until an admin
  // settings table/UI exists.
  GLOBAL_MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(25),
  // Layered on top of the global ceiling above via a Redis-backed
  // semaphore (concurrency.ts) — BullMQ's own `concurrency` option has
  // no native per-key variant. Default per REQUIREMENTS §2.1.
  PER_USER_MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(5),
  DEFAULT_JOB_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
  MAX_JOB_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(3600),
  DEFAULT_MAX_RETRIES: z.coerce.number().int().min(0).default(2),

  SCHEDULER_TICK_MS: z.coerce.number().int().positive().default(15_000),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type WorkerConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}
