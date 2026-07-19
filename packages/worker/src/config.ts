import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HEALTH_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  API_KEY_ENCRYPTION_KEY: z.string().min(32),

  LIBRECHAT_BASE_URL: z.string().url(),

  // Internal-only PDF-rendering component (§2.5) — see the API's
  // config.ts for the full rationale (same service, both processes call
  // it as clients).
  PDF_SERVICE_URL: z.string().url().default("http://localhost:4100"),
  // OCR pipeline service (#109). Unset = jobs with attachments run
  // without extraction (and log that they did), so the worker keeps
  // working on stacks that don't deploy the ocr container.
  OCR_SERVICE_URL: z.string().url().optional(),
  // Ceiling on the complete user prompt when attachments are present,
  // including the rendered template, attachment heading, extracted text,
  // and any truncation marker (~4 chars/token). Upload quotas bound input
  // FILE size, not extracted TEXT size. 80k chars is roughly 20k tokens,
  // leaving headroom for system/tool context and output in the smallest
  // bundled model's 32k-token context window.
  OCR_EXTRACTED_TEXT_MAX_CHARS: z.coerce.number().int().positive().default(80_000),
  // Ask the OCR service for vision-model descriptions of image
  // attachments ("what is this image about") in addition to text.
  // Not z.coerce.boolean(): that coerces the string "false" to true
  // (JS truthiness), silently enabling the feature it should disable.
  OCR_DESCRIBE_IMAGES: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  // Optional — must match pdf-service's own PDF_SERVICE_SHARED_SECRET.
  // Defense-in-depth on top of NetworkPolicy; unset preserves prior
  // unauthenticated behavior.
  PDF_SERVICE_SHARED_SECRET: z.string().optional(),

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

  // Orphan reaper (issue #123): a run whose worker crashed/restarted
  // mid-processing has no other process watching it — BullMQ's own
  // stalled-job recovery didn't reliably reclaim these in practice, so
  // this is a direct DB-side sweep instead. 5 minutes balances "orphaned
  // runs don't sit for hours" against not hammering Postgres with a
  // full-table-ish scan every few seconds.
  ORPHAN_REAPER_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  // A Run row is created before its BullMQ job is enqueued (two separate
  // calls, not a transaction) at both enqueue call sites — without this
  // grace period, a PENDING run swept in that narrow gap would look
  // identical to one truly orphaned by a crash between those two calls,
  // and get reaped while still about to be picked up normally.
  ORPHAN_REAPER_PENDING_GRACE_MS: z.coerce.number().int().positive().default(60_000),

  // Live system map (issue #131): how often the worker probes the links
  // only it can reach (LibreChat) and publishes the result to Redis with
  // a TTL, so the API's system-status endpoint can show it without the
  // API needing to reach LibreChat itself. 30s publish / 90s TTL (3x) is
  // the same generous-multiple pattern the reaper/concurrency TTLs use,
  // so one slow tick doesn't flicker a healthy link to stale.
  COMPONENT_STATUS_PUBLISH_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),

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
